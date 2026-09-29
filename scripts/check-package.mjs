import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
const files = new Set(pack.files.map((file) => file.path));
for (const file of [metadata.main, metadata.types, metadata.bin['jev-graph']]) assert(files.has(file), `Missing package entry ${file}`);
for (const platform of ['darwin', 'linux', 'windows']) {
  for (const arch of ['amd64', 'arm64']) {
    const binary = `bin/native/jev-graph-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    assert(files.has(binary), `Missing native target ${binary}`);
  }
}
assert.deepEqual(metadata.pi.extensions, ['./dist/index.js']);
console.log(`Package verified: ${files.size} files, main/types/CLI and all six native targets present.`);
