import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { configuration } from '@/configuration';

type CodexExecutableResolutionOptions = {
    envPath?: string;
    settingsFile?: string;
    vscodeExtensionsDirs?: string[];
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

// VS Code can keep an old extension directory after installing an update.
// A path saved by the bridge is discovery state, so follow newer siblings
// with the same platform layout even while the old binary still exists.
function refreshSavedVscodeExecutable(path: string): string {
    const platformDir = dirname(path);
    const binDir = dirname(platformDir);
    const extensionDir = dirname(binDir);
    const extensionName = basename(extensionDir);
    if (basename(binDir) !== 'bin' || !extensionName.startsWith('openai.chatgpt-')) return path;

    try {
        const extensionsDir = dirname(extensionDir);
        const newerNames = readdirSync(extensionsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-')
                && entry.name.localeCompare(extensionName, undefined, { numeric: true }) > 0)
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const name of newerNames) {
            const candidate = join(extensionsDir, name, 'bin', basename(platformDir), basename(path));
            if (isExecutableFile(candidate)) return candidate;
        }
    } catch {
        // Keep the usable saved binary when discovery is unavailable.
    }
    return path;
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
            ? refreshSavedVscodeExecutable(settings.codexPath)
            : null;
    } catch {
        return null;
    }
}

function discoverVscodeCodexExecutable(extensionsDirs: string[]): string | null {
    const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
    for (const extensionsDir of extensionsDirs) {
        try {
            const extensionNames = readdirSync(extensionsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
                .map((entry) => entry.name)
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const extensionName of extensionNames) {
                const binDir = join(extensionsDir, extensionName, 'bin');
                try {
                    for (const platformDir of readdirSync(binDir, { withFileTypes: true })) {
                        if (!platformDir.isDirectory()) continue;
                        const candidate = join(binDir, platformDir.name, executable);
                        if (isExecutableFile(candidate)) return candidate;
                    }
                } catch {
                    // Try the next installed extension version.
                }
            }
        } catch {
            // Try the next VS Code extensions directory.
        }
    }
    return null;
}

export function resolveCodexExecutable(
    options: CodexExecutableResolutionOptions = {},
): string {
    return resolveConfiguredCodexExecutable(options)
        ?? discoverVscodeCodexExecutable(options.vscodeExtensionsDirs ?? [
            join(homedir(), '.vscode', 'extensions'),
            join(homedir(), '.vscode-insiders', 'extensions'),
        ])
        ?? 'codex';
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
