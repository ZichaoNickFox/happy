import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { SessionEnvelope } from '@slopus/happy-wire';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { initialMachineMetadata } from '@/daemon/run';
import { readCredentials, readSettings, updateSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { encodeBase64 } from '@/api/encryption';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import {
    codexCatalogNamespace,
    persistCodexSession,
    resolveOrCreateCodexSession,
} from './codexSessionIdentity';
import {
    type JsonRpcMessage,
    VscodeCodexProxyCore,
} from './vscodeCodexProxyCore';

type ProxyArgs = {
    codexPath: string;
    codexArgs: string[];
};

type ThreadBridge = {
    session: ApiSessionClient;
    keepAlive: NodeJS.Timeout;
    thinking: boolean;
    closed: boolean;
    closePromise: Promise<void> | null;
};

function proxyLog(message: string): void {
    process.stderr.write(`[happy-vscode] ${message}\n`);
}

export function parseVscodeCodexProxyArgs(args: string[]): ProxyArgs {
    const separator = args.indexOf('--');
    const options = separator >= 0 ? args.slice(0, separator) : args;
    const codexArgs = separator >= 0 ? args.slice(separator + 1) : [];
    const pathIndex = options.indexOf('--codex-path');
    const codexPath = pathIndex >= 0 ? options[pathIndex + 1] : undefined;
    if (!codexPath) {
        throw new Error('happy vscode-codex-proxy requires --codex-path <absolute path> -- <codex args>');
    }
    return { codexPath, codexArgs };
}

function jsonLine(message: JsonRpcMessage): string {
    return `${JSON.stringify(message)}\n`;
}

export async function runVscodeCodexProxy(args: string[]): Promise<void> {
    const parsed = parseVscodeCodexProxyArgs(args);
    process.env.HAPPY_CODEX_PATH = parsed.codexPath;
    try {
        await updateSettings((settings) => ({ ...settings, codexPath: parsed.codexPath }));
    } catch (error) {
        proxyLog(`Could not persist the bundled Codex path: ${error instanceof Error ? error.message : String(error)}`);
    }
    const child = spawn(parsed.codexPath, parsed.codexArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });

    child.stderr.pipe(process.stderr);
    child.stdin.on('error', () => {
        // The app-server may close stdin before VS Code notices its exit.
    });
    const bridges = new Map<string, Promise<ThreadBridge | null>>();
    let closeThreadBridge!: (threadId: string, bridge: ThreadBridge, reason: string, archiveThread: boolean) => Promise<void>;
    let daemonReadyPromise: Promise<void> | null = null;

    const ensureBridgeDaemon = (): Promise<void> => {
        if (!daemonReadyPromise) {
            daemonReadyPromise = ensureDaemonRunning().catch((error) => {
                daemonReadyPromise = null;
                throw error;
            });
        }
        return daemonReadyPromise;
    };

    const createBridge = async (threadId: string, cwd: string): Promise<ThreadBridge | null> => {
        try {
            const credentials = await readCredentials();
            const settings = await readSettings();
            if (!credentials || !settings.machineId) {
                proxyLog('Happy is not authenticated; run `happy auth login`, then reload VS Code. Codex continues without mobile sync.');
                return null;
            }

            const api = await ApiClient.create(credentials);
            await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });
            await ensureBridgeDaemon();
            const { metadata, state } = createSessionMetadata({
                flavor: 'codex',
                machineId: settings.machineId,
                startedBy: 'terminal',
            });
            metadata.path = cwd;
            metadata.codexThreadId = threadId;
            metadata.name = 'VS Code Codex';
            metadata.codexCatalogManaged = true;
            metadata.codexCatalogNamespace = codexCatalogNamespace();
            metadata.codexProviderArchived = false;

            const created = await resolveOrCreateCodexSession({
                api,
                machineId: settings.machineId,
                threadId,
                metadata,
                state,
            });

            const session = api.sessionSyncClient(created);
            session.skipExistingMessages();
            await session.updateMetadataAndWait((current) => ({
                ...current,
                ...metadata,
                path: cwd,
                lifecycleState: 'running',
                lifecycleStateSince: Date.now(),
            }));
            const persistedMetadata = session.getMetadata() ?? metadata;
            const snapshot = session.getSessionSnapshot();
            persistCodexSession(snapshot, persistedMetadata);
            void notifyDaemonSessionStarted(snapshot.id, persistedMetadata, {
                encryptionKey: encodeBase64(snapshot.encryptionKey),
                encryptionVariant: snapshot.encryptionVariant,
                seq: snapshot.seq,
                metadataVersion: snapshot.metadataVersion,
                agentStateVersion: snapshot.agentStateVersion,
            });
            session.onUserMessage((message) => {
                core.sendMobileText(threadId, message.content.text, message.localKey);
            });
            let bridge!: ThreadBridge;
            const keepAlive = setInterval(() => {
                if (!bridge.closed) session.keepAlive(bridge.thinking, 'remote');
            }, 2_000);
            bridge = { session, thinking: false, keepAlive, closed: false, closePromise: null };
            registerKillSessionHandler(session.rpcHandlerManager, async () => {
                // Let the RPC success response leave over the session socket
                // before closing that socket.
                setImmediate(() => {
                    void closeThreadBridge(threadId, bridge, 'Closed from Happy mobile', true);
                });
            });
            session.on('archived', () => {
                void closeThreadBridge(threadId, bridge, 'Archived from Happy mobile', true);
            });
            session.keepAlive(bridge.thinking, 'remote');
            session.sendSessionEvent({ type: 'ready' });
            proxyLog(`Codex thread ${threadId} is synced as Happy session ${session.sessionId}.`);
            return bridge;
        } catch (error) {
            proxyLog(`Happy sync failed for Codex thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    };

    const withBridge = (threadId: string, callback: (bridge: ThreadBridge) => void): void => {
        const promise = bridges.get(threadId);
        if (!promise) return;
        void promise.then((bridge) => {
            if (bridge && !bridge.closed) callback(bridge);
        });
    };

    const core = new VscodeCodexProxyCore({
        writeToCodex: (message) => child.stdin.write(jsonLine(message)),
        writeToVscode: (message) => process.stdout.write(jsonLine(message)),
        registerThread: ({ threadId, cwd }) => {
            if (!bridges.has(threadId)) {
                bridges.set(threadId, createBridge(threadId, cwd));
            }
        },
        mirrorUserTurn: ({ threadId, text, messageId }) => {
            withBridge(threadId, ({ session }) => {
                session.sendSessionProtocolMessageWithLocalId({
                    id: messageId,
                    time: Date.now(),
                    role: 'user',
                    ev: { t: 'text', text },
                }, messageId);
            });
        },
        mirrorNotification: (threadId: string, envelopes: SessionEnvelope[]) => {
            withBridge(threadId, (bridge) => {
                const { session } = bridge;
                for (const envelope of envelopes) {
                    session.sendSessionProtocolMessageWithLocalId(
                        envelope,
                        `codex-history:${threadId}:${envelope.id}`,
                    );
                }
                if (envelopes.some((envelope) => envelope.ev.t === 'turn-start')) {
                    bridge.thinking = true;
                    session.keepAlive(true, 'remote');
                }
                if (envelopes.some((envelope) => envelope.ev.t === 'turn-end')) {
                    bridge.thinking = false;
                    session.keepAlive(false, 'remote');
                    session.sendSessionEvent({ type: 'ready' });
                }
            });
        },
    });

    closeThreadBridge = (threadId, bridge, reason, archiveThread) => {
        if (bridge.closePromise) return bridge.closePromise;
        bridge.closed = true;
        clearInterval(bridge.keepAlive);
        if (archiveThread) core.archiveMobileThread(threadId);
        bridge.closePromise = (async () => {
            try {
                await bridge.session.updateMetadataAndWait((current) => ({
                    ...current,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: reason,
                    ...(archiveThread ? { codexProviderArchived: true } : {}),
                }));
                bridge.session.sendSessionDeath();
                await bridge.session.flush();
            } catch (error) {
                proxyLog(`Failed to close Happy bridge for Codex thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                await bridge.session.close();
                bridges.delete(threadId);
                proxyLog(`Codex thread ${threadId} is no longer synced to Happy (${reason}).`);
            }
        })();
        return bridge.closePromise;
    };

    const vscodeInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
    vscodeInput.on('line', (line) => {
        try {
            core.fromVscode(JSON.parse(line) as JsonRpcMessage);
        } catch {
            child.stdin.write(`${line}\n`);
        }
    });
    vscodeInput.on('close', () => child.stdin.end());

    const codexOutput = createInterface({ input: child.stdout, crlfDelay: Infinity });
    codexOutput.on('line', (line) => {
        try {
            core.fromCodex(JSON.parse(line) as JsonRpcMessage);
        } catch {
            process.stdout.write(`${line}\n`);
        }
    });

    const shutdown = async (): Promise<void> => {
        vscodeInput.close();
        codexOutput.close();
        const active = await Promise.all(bridges.values());
        await Promise.all(active.filter((bridge): bridge is ThreadBridge => bridge !== null).map(async (bridge) => {
            const metadata = bridge.session.getMetadata();
            const threadId = metadata?.codexThreadId;
            if (threadId) {
                await closeThreadBridge(threadId, bridge, 'VS Code Codex proxy stopped', false);
            }
        }));
    };

    const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
    }).finally(async () => {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        await shutdown();
    });

    process.exitCode = exitCode;
}
