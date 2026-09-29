#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!arch || !['darwin', 'linux', 'win32'].includes(process.platform)) {
  console.error(`jev-graph: unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const file = `jev-graph-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
const binary = join(__dirname, '..', 'bin', 'native', file);
if (!existsSync(binary)) {
  console.error(`jev-graph: missing ${file}; build the package with "bun run build:native".`);
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) console.error(`jev-graph: ${result.error.message}`);
process.exit(result.status ?? 1);
