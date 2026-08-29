import { createHash } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ApiClient } from '@/api/api';
import type { AgentState, Metadata, Session } from '@/api/types';
import { configuration } from '@/configuration';
import {
    persistSession,
    readPersistedSessions,
    type PersistedSession,
} from '@/persistence';
import { decodeBase64, encodeBase64 } from '@/api/encryption';

export function codexSessionTag(machineId: string, threadId: string): string {
    const digest = createHash('sha256')
        .update(`${machineId}\0${threadId}`)
        .digest('hex');
    return `codex-thread:${machineId}:${digest}`;
}

export function codexCatalogNamespace(): string {
    const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    return createHash('sha256').update(codexHome).digest('hex');
}

export function findPersistedCodexSession(threadId: string, machineId?: string): {
    sessionId: string;
    persisted: PersistedSession;
} | null {
    for (const [sessionId, persisted] of Object.entries(readPersistedSessions())) {
        if (persisted.metadata.codexThreadId === threadId
            && (!machineId || persisted.metadata.machineId === machineId)) {
            return { sessionId, persisted };
        }
    }
    return null;
}

export function sessionFromPersisted(sessionId: string, persisted: PersistedSession): Session {
    return {
        id: sessionId,
        seq: persisted.seq,
        encryptionKey: decodeBase64(persisted.encryptionKey),
        encryptionVariant: persisted.encryptionVariant,
        metadata: persisted.metadata,
        metadataVersion: persisted.metadataVersion,
        agentState: null,
        agentStateVersion: persisted.agentStateVersion,
    };
}

export function persistCodexSession(session: Session, metadata: Metadata = session.metadata): void {
    persistSession(session.id, {
        encryptionKey: encodeBase64(session.encryptionKey),
        encryptionVariant: session.encryptionVariant,
        seq: session.seq,
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        metadata,
        savedAt: Date.now(),
    });
}

function codexSessionLockPath(machineId: string, threadId: string): string {
    const digest = createHash('sha256')
        .update(`${machineId}\0${threadId}`)
        .digest('hex');
    return join(configuration.happyHomeDir, `codex-session-${digest}.lock`);
}

function isFileExistsError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function resolveOrCreateCodexSession(options: {
    api: ApiClient;
    machineId: string;
    threadId: string;
    metadata: Metadata;
    state: AgentState;
}): Promise<Session> {
    const lockPath = codexSessionLockPath(options.machineId, options.threadId);
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    for (let attempt = 0; attempt < 200 && !handle; attempt += 1) {
        try {
            handle = await open(lockPath, 'wx', 0o600);
        } catch (error) {
            if (!isFileExistsError(error)) throw error;
            try {
                const lockStat = await stat(lockPath);
                if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath);
            } catch {
                // The lock may have been released between stat and unlink.
            }
            await wait(50);
        }
    }

    if (!handle) throw new Error(`Timed out resolving Codex thread ${options.threadId}`);

    try {
        const persisted = findPersistedCodexSession(options.threadId, options.machineId);
        if (persisted) return sessionFromPersisted(persisted.sessionId, persisted.persisted);

        const session = await options.api.getOrCreateSession({
            tag: codexSessionTag(options.machineId, options.threadId),
            metadata: options.metadata,
            state: options.state,
        });
        if (!session) throw new Error('Happy session creation failed');
        persistCodexSession(session, options.metadata);
        return session;
    } finally {
        await handle.close();
        try {
            await unlink(lockPath);
        } catch {
            // A stale-lock cleanup racing with close is harmless.
        }
    }
}
