import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const comparable = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function statOrMissing(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) { if (missing(error)) return undefined; throw error; }
}

/** Resolve existing ancestors too, so missing files under /var aliases compare correctly. */
export function canonicalConfigPath(file: string): string {
  const resolved = path.resolve(file);
  try { return fs.realpathSync(resolved); } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonicalConfigPath(parent), path.basename(resolved));
  }
}

export function isProtectedConfigPath(file: string, protectedFiles: string[]): boolean {
  const target = comparable(canonicalConfigPath(file));
  return protectedFiles.some((protectedFile) => comparable(canonicalConfigPath(protectedFile)) === target);
}

/** Refuse links (including parent links) before creating, reading or replacing a config. */
export function writeSafeConfig(
  file: string, allowedRoot: string, protectedFiles: string[], update: (existing: string | null) => string,
): void {
  const declaredRoot = path.resolve(allowedRoot);
  const relative = path.relative(declaredRoot, path.resolve(file));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Refusing config write outside its permitted root');
  }
  const root = fs.realpathSync(declaredRoot);
  const target = path.join(root, relative);
  const protectedPaths = new Set(protectedFiles.map((file) => comparable(canonicalConfigPath(file))));
  const parent = path.dirname(target);
  const parents = relative.split(path.sep).slice(0, -1);
  const identities = new Map<string, string>();
  const validate = (create: boolean) => {
    if (comparable(fs.realpathSync(declaredRoot)) !== comparable(root)) throw new Error('Config root changed during save');
    let current = root;
    for (const component of ['', ...parents]) {
      if (component) current = path.join(current, component);
      let stat = statOrMissing(current);
      if (!stat && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing config write through a linked or invalid directory');
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(current) && identities.get(current) !== identity) throw new Error('Config directory changed during save');
      identities.set(current, identity);
    }
    const stat = statOrMissing(target);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('Refusing linked or non-regular config file');
    if (protectedPaths.has(comparable(target))) throw new Error('Refusing project write to protected global configuration');
  };
  validate(true);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let existing: string | null = null;
  let source: number | undefined;
  try {
    validate(false);
    source = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(source);
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Refusing linked or non-regular config file');
    existing = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (!missing(error)) throw error;
  } finally { if (source !== undefined) fs.closeSync(source); }

  const output = update(existing);
  const temporary = path.join(parent, `.jev-config-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    validate(false);
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, output, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    validate(false);
    fs.renameSync(temporary, target); // replace a directory entry, never truncate/follow its target
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      validate(false); // do not unlink via a parent that was redirected after staging
      fs.unlinkSync(temporary);
    } catch { /* temporary may already have been renamed; never touch an unsafe path */ }
  }
}
