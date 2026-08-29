'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildPosixWrapper,
  deriveProxyExecutable,
  isManagedWrapper,
  resolveExecutablePath,
  resolveBundledCodexPath,
  wrapperPaths
} = require('../src/bridgeConfig');

test('POSIX wrapper quotes executable paths and preserves Codex arguments', () => {
  const wrapper = buildPosixWrapper('/tmp/Happy CLI/happy-vscode-codex', "/tmp/Codex's bin/codex");
  assert.match(wrapper, /happy-vscode-codex/);
  assert.match(wrapper, /--codex-path/);
  assert.match(wrapper, /-- "\$@"/);
  assert.match(wrapper, /'\/tmp\/Happy CLI\/happy-vscode-codex'/);
});

test('derives the direct proxy executable next to an absolute Happy executable', () => {
  assert.equal(
    deriveProxyExecutable('/usr/local/bin/happy'),
    '/usr/local/bin/happy-vscode-codex'
  );
  assert.equal(deriveProxyExecutable('happy'), 'happy-vscode-codex');
});

test('resolves an executable from PATH without shell interpolation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-path-'));
  const executable = process.platform === 'win32' ? 'happy-test.cmd' : 'happy-test';
  const executablePath = path.join(root, executable);
  fs.writeFileSync(executablePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o700);

  assert.equal(resolveExecutablePath('happy-test', {
    PATH: root,
    PATHEXT: '.EXE;.CMD;.BAT;.COM'
  }), executablePath);
});

test('resolves the single Codex binary bundled by the official extension', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-codex-extension-'));
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const binary = path.join(root, 'bin', 'test-platform', executable);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  assert.equal(resolveBundledCodexPath(root), binary);
});

test('recognizes only wrappers inside this extension global storage', () => {
  const storage = path.join(os.tmpdir(), 'happy-codex-storage');
  const paths = wrapperPaths(storage);
  assert.equal(isManagedWrapper(paths.posix, storage), true);
  assert.equal(isManagedWrapper('/tmp/some-other-wrapper', storage), false);
});
