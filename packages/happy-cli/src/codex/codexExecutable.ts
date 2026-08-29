import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { configuration } from '@/configuration';

type CodexExecutableResolutionOptions = {
    envPath?: string;
    settingsFile?: string;
};

function isExecutableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the Codex binary explicitly configured by the VS Code bridge.
 * This is intentionally separate from PATH lookup: the official extension
 * bundles Codex without installing a global `codex` command.
 */
export function resolveConfiguredCodexExecutable(
    options: CodexExecutableResolutionOptions = {},
): string | null {
    const envPath = options.envPath ?? process.env.HAPPY_CODEX_PATH;
    if (envPath && isExecutableFile(envPath)) return envPath;

    const settingsFile = options.settingsFile ?? configuration.settingsFile;
    try {
        const settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as { codexPath?: unknown };
        return typeof settings.codexPath === 'string' && isExecutableFile(settings.codexPath)
            ? settings.codexPath
            : null;
    } catch {
        return null;
    }
}

export function resolveCodexExecutable(): string {
    return resolveConfiguredCodexExecutable() ?? 'codex';
}

export function isCodexExecutableAvailable(executable = resolveCodexExecutable()): boolean {
    try {
        execFileSync(executable, ['--version'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}
