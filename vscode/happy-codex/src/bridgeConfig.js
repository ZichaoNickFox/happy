'use strict';

const fs = require('node:fs');
const path = require('node:path');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function resolveBundledCodexPath(extensionPath) {
  const binDir = path.join(extensionPath, 'bin');
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (!fs.existsSync(binDir)) {
    throw new Error(`Official Codex extension has no bundled binary directory: ${binDir}`);
  }

  const candidates = fs.readdirSync(binDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(binDir, entry.name, executable))
    .filter((candidate) => fs.existsSync(candidate));

  if (candidates.length !== 1) {
    throw new Error(`Expected one bundled Codex executable, found ${candidates.length}.`);
  }
  return candidates[0];
}

function wrapperPaths(storagePath) {
  return {
    posix: path.join(storagePath, 'happy-codex-proxy'),
    windows: path.join(storagePath, 'happy-codex-proxy.cmd')
  };
}

function buildPosixWrapper(proxyExecutable, codexExecutable) {
  return [
    '#!/bin/sh',
    `exec ${shellQuote(proxyExecutable)} --codex-path ${shellQuote(codexExecutable)} -- "$@"`,
    ''
  ].join('\n');
}

function buildWindowsWrapper(proxyExecutable, codexExecutable) {
  return [
    '@echo off',
    `${cmdQuote(proxyExecutable)} --codex-path ${cmdQuote(codexExecutable)} -- %*`,
    ''
  ].join('\r\n');
}

function createWrapper(storagePath, proxyExecutable, codexExecutable) {
  fs.mkdirSync(storagePath, { recursive: true });
  const paths = wrapperPaths(storagePath);
  if (process.platform === 'win32') {
    fs.writeFileSync(paths.windows, buildWindowsWrapper(proxyExecutable, codexExecutable), 'utf8');
    return paths.windows;
  }

  fs.writeFileSync(paths.posix, buildPosixWrapper(proxyExecutable, codexExecutable), {
    encoding: 'utf8',
    mode: 0o700
  });
  fs.chmodSync(paths.posix, 0o700);
  return paths.posix;
}

function deriveProxyExecutable(happyExecutable) {
  const parsed = path.parse(happyExecutable);
  if (parsed.dir) {
    return path.join(parsed.dir, `happy-vscode-codex${parsed.ext}`);
  }
  return 'happy-vscode-codex';
}

function resolveExecutablePath(command, env = process.env) {
  const value = String(command || '').trim();
  if (!value) throw new Error('Happy CLI executable is empty.');

  const hasDirectory = path.isAbsolute(value) || value.includes('/') || value.includes('\\');
  const pathEntries = hasDirectory
    ? ['']
    : String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const hasWindowsExtension = process.platform === 'win32' && path.extname(value) !== '';

  for (const directory of pathEntries) {
    const base = hasDirectory
      ? path.resolve(value)
      : path.join(directory, value);
    const candidates = hasWindowsExtension ? [base] : extensions.map((extension) => `${base}${extension}`);
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  throw new Error(`Happy CLI not found: ${value}`);
}

function isManagedWrapper(configuredPath, storagePath) {
  if (!configuredPath) return false;
  const paths = wrapperPaths(storagePath);
  return path.resolve(configuredPath) === path.resolve(paths.posix)
    || path.resolve(configuredPath) === path.resolve(paths.windows);
}

module.exports = {
  buildPosixWrapper,
  buildWindowsWrapper,
  createWrapper,
  deriveProxyExecutable,
  isManagedWrapper,
  resolveExecutablePath,
  resolveBundledCodexPath,
  wrapperPaths
};
