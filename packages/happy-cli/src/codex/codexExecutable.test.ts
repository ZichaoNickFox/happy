import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isCodexExecutableAvailable, resolveConfiguredCodexExecutable } from './codexExecutable';

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

    it.runIf(process.platform !== 'win32')('probes the resolved executable without using a shell command', () => {
        const directory = temporaryDirectory();
        const executable = join(directory, 'codex');
        writeFileSync(executable, '#!/bin/sh\n[ "$1" = "--version" ]\n', 'utf-8');
        chmodSync(executable, 0o700);

        expect(isCodexExecutableAvailable(executable)).toBe(true);
        expect(isCodexExecutableAvailable(join(directory, 'missing'))).toBe(false);
    });
});
