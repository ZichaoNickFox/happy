import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isCodexExecutableAvailable, resolveCodexExecutable, resolveConfiguredCodexExecutable } from './codexExecutable';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'happy-codex-executable-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('resolveConfiguredCodexExecutable', () => {
    it('follows a newer saved VS Code binary while the old extension still exists', () => {
        const directory = temporaryDirectory();
        const settingsFile = join(directory, 'settings.json');
        const makeBinary = (version: string, platform = 'same-platform') => {
            const bin = join(directory, `openai.chatgpt-${version}-test`, 'bin', platform);
            mkdirSync(bin, { recursive: true });
            const executable = join(bin, 'codex');
            writeFileSync(executable, '#!/bin/sh\n', 'utf-8');
            chmodSync(executable, 0o700);
            return executable;
        };
        const old = makeBinary('26.9.0');
        const latest = makeBinary('26.10.0');
        makeBinary('26.11.0', 'other-platform');
        writeFileSync(settingsFile, JSON.stringify({ codexPath: old }), 'utf-8');

        expect(resolveCodexExecutable({ envPath: '', settingsFile })).toBe(latest);
        // An explicit environment override remains a deliberate pin.
        expect(resolveCodexExecutable({ envPath: old, settingsFile })).toBe(old);
        // An unavailable update must not break the usable saved installation.
        rmSync(latest);
        expect(resolveCodexExecutable({ envPath: '', settingsFile })).toBe(old);
    });

    it('uses the executable persisted by the VS Code bridge', () => {
        const directory = temporaryDirectory();
        const executable = join(directory, 'codex');
        const settingsFile = join(directory, 'settings.json');
        writeFileSync(executable, '#!/bin/sh\n', 'utf-8');
        chmodSync(executable, 0o700);
        writeFileSync(settingsFile, JSON.stringify({ codexPath: executable }), 'utf-8');

        expect(resolveConfiguredCodexExecutable({ settingsFile })).toBe(executable);
    });

    it('prefers a valid environment override', () => {
        const directory = temporaryDirectory();
        const executable = join(directory, 'codex-env');
        writeFileSync(executable, '#!/bin/sh\n', 'utf-8');
        chmodSync(executable, 0o700);

        expect(resolveConfiguredCodexExecutable({
            envPath: executable,
            settingsFile: join(directory, 'missing-settings.json'),
        })).toBe(executable);
    });

    it('rejects missing configured binaries', () => {
        const directory = temporaryDirectory();
        const settingsFile = join(directory, 'settings.json');
        writeFileSync(settingsFile, JSON.stringify({ codexPath: join(directory, 'missing') }), 'utf-8');

        expect(resolveConfiguredCodexExecutable({ settingsFile })).toBeNull();
    });

    it('recovers from a stale saved path after the VS Code extension updates', () => {
        const directory = temporaryDirectory();
        const extensionsDir = join(directory, 'extensions');
        const platformDir = join(extensionsDir, 'openai.chatgpt-26.825.51511-test', 'bin', 'platform');
        const executable = join(platformDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
        const settingsFile = join(directory, 'settings.json');
        mkdirSync(platformDir, { recursive: true });
        writeFileSync(executable, '#!/bin/sh\n', 'utf-8');
        chmodSync(executable, 0o700);
        writeFileSync(settingsFile, JSON.stringify({ codexPath: join(directory, 'removed-codex') }), 'utf-8');

        expect(resolveCodexExecutable({ settingsFile, vscodeExtensionsDirs: [extensionsDir] })).toBe(executable);
    });

    it.runIf(process.platform !== 'win32')('probes the resolved executable without using a shell command', () => {
        const directory = temporaryDirectory();
        const executable = join(directory, 'codex');
        writeFileSync(executable, '#!/bin/sh\n[ "$1" = "--version" ]\n', 'utf-8');
        chmodSync(executable, 0o700);

        expect(isCodexExecutableAvailable(executable)).toBe(true);
        expect(isCodexExecutableAvailable(join(directory, 'missing'))).toBe(false);
    });
});
