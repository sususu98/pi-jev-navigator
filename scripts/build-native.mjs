import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platforms = ['darwin', 'linux', 'windows'];
const architectures = ['amd64', 'arm64'];
mkdirSync(resolve(root, 'bin/native'), { recursive: true });
for (const platform of platforms) {
  for (const arch of architectures) {
    const filename = `jev-graph-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    console.log(`Building ${filename}`);
    const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', resolve(root, 'bin/native', filename), './cmd/jev-graph'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', GOOS: platform, GOARCH: arch },
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
