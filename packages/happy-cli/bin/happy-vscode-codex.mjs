#!/usr/bin/env node

if (process.argv[2] === '--probe') {
  process.stdout.write('happy-vscode-codex\n');
} else {
  process.argv.splice(2, 0, 'vscode-codex-proxy');
  await import('../dist/index.mjs');
}
