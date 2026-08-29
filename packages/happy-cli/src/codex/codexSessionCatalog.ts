import type { ApiClient } from '@/api/api';
import type { Metadata, Session } from '@/api/types';
import { logger } from '@/ui/logger';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import {
    removePersistedSession,
    readPersistedSessions,
    readSettings,
} from '@/persistence';
import { mapCodexThreadToSessionEnvelopes } from '@/codex/utils/sessionProtocolMapper';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { Thread, ThreadSourceKind } from '@/codex/codexAppServerTypes';
import {
    codexCatalogNamespace,
    persistCodexSession,
    resolveOrCreateCodexSession,
} from '@/codex/codexSessionIdentity';
import { stripHappySystemBlocks } from '@/codex/codexPrompt';

const CATALOG_SOURCE_KINDS: ThreadSourceKind[] = [
    'cli',
    'vscode',
    'exec',
    'appServer',
    'unknown',
];

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_CONCURRENCY = 4;
const INVENTORY_CONCURRENCY = 8;
const CLEANUP_CONCURRENCY = 8;

export type CodexCatalogThread = {
    threadId: string;
    happySessionId: string;
    name: string | null;
    preview: string;
    cwd: string;
    archived: boolean;
    createdAt: number;
    updatedAt: number;
    backfilledUpdatedAt: number | null;
    source: string;
    status: string;
};

function timestampMs(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return Date.now();
    return value < 10_000_000_000 ? value * 1000 : value;
}

function sourceName(source: Thread['source']): string {
    if (typeof source === 'string') return source;
    if (source && typeof source === 'object' && 'custom' in source && typeof source.custom === 'string') {
        return source.custom;
    }
    if (source && typeof source === 'object' && 'subAgent' in source) return 'subAgent';
    return 'unknown';
}

function displayName(thread: Thread): string {
    return thread.name?.trim() || cleanPreview(thread) || 'Codex session';
}

function cleanPreview(thread: Thread): string {
    return stripHappySystemBlocks(thread.preview?.trim() || '');
}

export function codexCatalogMetadata(
    base: Metadata,
    thread: Thread,
    archived: boolean,
): Metadata {
    const updatedAt = timestampMs(thread.updatedAt);
    const title = displayName(thread);
    return {
        ...base,
        path: thread.cwd || base.path,
        name: title,
        summary: { text: title, updatedAt },
        codexThreadId: thread.id,
        codexCatalogManaged: true,
        codexCatalogNamespace: codexCatalogNamespace(),
        codexProviderArchived: archived,
        codexUpdatedAt: updatedAt,
        codexSource: sourceName(thread.source),
        lifecycleState: archived ? 'archived' : 'running',
        lifecycleStateSince: updatedAt,
        ...(archived
            ? { archivedBy: 'codex', archiveReason: 'Archived in Codex' }
            : { archivedBy: undefined, archiveReason: undefined }),
    };
}

function catalogRow(
    thread: Thread,
    happySessionId: string,
    archived: boolean,
    backfilledUpdatedAt: number | null = null,
): CodexCatalogThread {
    return {
        threadId: thread.id,
        happySessionId,
        name: thread.name ?? null,
        preview: cleanPreview(thread),
        cwd: thread.cwd ?? '',
        archived,
        createdAt: timestampMs(thread.createdAt),
        updatedAt: timestampMs(thread.updatedAt),
        backfilledUpdatedAt,
        source: sourceName(thread.source),
        status: thread.status?.type ?? 'unknown',
    };
}

export class CodexSessionCatalog {
    private client: CodexAppServerClient | null = null;
    private clientPromise: Promise<CodexAppServerClient> | null = null;
    private reconcileTimer: NodeJS.Timeout | null = null;
    private reconcilePromise: Promise<CodexCatalogThread[]> | null = null;
    private historyBackfillPromise: Promise<void> | null = null;
    private readonly rows = new Map<string, CodexCatalogThread>();
    private readonly missingReconciliations = new Map<string, number>();
    private stopped = false;

    constructor(
        private readonly api: ApiClient,
        private readonly machineId: string,
        private readonly reconcileIntervalMs = Number(
            process.env.HAPPY_CODEX_CATALOG_INTERVAL_MS || DEFAULT_RECONCILE_INTERVAL_MS,
        ),
    ) {}

    async start(): Promise<void> {
        this.stopped = false;
        try {
            await this.syncNow();
        } catch (error) {
            logger.debug('[CODEX CATALOG] Initial sync failed; daemon will retry', error);
        }
        if (this.stopped || this.reconcileTimer) return;
        this.reconcileTimer = setInterval(() => {
            void this.syncNow().catch((error) => {
                logger.debug('[CODEX CATALOG] Periodic sync failed', error);
            });
        }, Math.max(5_000, this.reconcileIntervalMs));
        this.reconcileTimer.unref();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        const client = this.client;
        this.client = null;
        this.clientPromise = null;
        if (client) await client.disconnect();
    }

    list(): CodexCatalogThread[] {
        return [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async syncNow(): Promise<CodexCatalogThread[]> {
        if (this.reconcilePromise) return this.reconcilePromise;
        this.reconcilePromise = this.reconcile().finally(() => {
            this.reconcilePromise = null;
        });
        return this.reconcilePromise;
    }

    async renameThread(threadId: string, name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Thread name is required');
        const client = await this.ensureClient();
        await client.setThreadName({ threadId, name: trimmed });
        await this.syncAfterMutation();
    }

    async archiveThread(threadId: string): Promise<void> {
        const client = await this.ensureClient();
        await client.archiveThread({ threadId });
        await this.syncAfterMutation();
    }

    async unarchiveThread(threadId: string): Promise<void> {
        const client = await this.ensureClient();
        await client.unarchiveThread({ threadId });
        await this.syncAfterMutation();
    }

    async deleteThread(threadId: string): Promise<void> {
        const client = await this.ensureClient();
        await client.deleteThread({ threadId });
        this.rows.delete(threadId);
    }

    private async ensureClient(): Promise<CodexAppServerClient> {
        if (this.client?.isConnected()) return this.client;
        if (this.clientPromise) return this.clientPromise;
        const staleClient = this.client;
        this.client = null;
        this.clientPromise = (async () => {
            if (staleClient) await staleClient.disconnect();
            const settings = await readSettings();
            const client = new CodexAppServerClient(undefined, settings.codexPath);
            await client.connect();
            this.client = client;
            return client;
        })().finally(() => {
            this.clientPromise = null;
        });
        return this.clientPromise;
    }

    private async syncAfterMutation(): Promise<CodexCatalogThread[]> {
        const inFlight = this.reconcilePromise;
        if (inFlight) await inFlight;
        return this.syncNow();
    }

    private async listProviderThreads(archived: boolean): Promise<Thread[]> {
        const client = await this.ensureClient();
        const threads: Thread[] = [];
        let cursor: string | null = null;
        do {
            const page = await client.listThreads({
                archived,
                cursor,
                limit: 100,
                sortKey: 'updated_at',
                sortDirection: 'desc',
                sourceKinds: CATALOG_SOURCE_KINDS,
            });
            threads.push(...page.data.filter((thread) => !thread.ephemeral));
            cursor = page.nextCursor;
        } while (cursor);
        return threads;
    }

    private async reconcile(): Promise<CodexCatalogThread[]> {
        // The phone catalog intentionally mirrors only provider-unarchived
        // threads. Archived Codex history remains local and can be restored in
        // Codex without making the phone download hundreds of dormant mirrors.
        // Snapshot the local registry before asking Codex for its inventory. A
        // VS Code thread created while thread/list is in flight must not be
        // mistaken for a stale mirror from that older inventory snapshot.
        const persistedSnapshot = readPersistedSessions();
        const active = await this.listProviderThreads(false);
        const providerRows = active.map((thread) => ({ thread, archived: false }));
        const seen = new Set(providerRows.map(({ thread }) => thread.id));
        for (const threadId of seen) this.missingReconciliations.delete(threadId);
        const previouslyManaged = new Map(this.rows);
        const namespace = codexCatalogNamespace();
        for (const [happySessionId, persisted] of Object.entries(persistedSnapshot)) {
            const metadata = persisted.metadata;
            const threadId = metadata.codexThreadId;
            if (!threadId
                || metadata.codexCatalogManaged !== true
                || metadata.machineId !== this.machineId
                || metadata.codexCatalogNamespace !== namespace
                || previouslyManaged.has(threadId)) {
                continue;
            }
            previouslyManaged.set(threadId, {
                threadId,
                happySessionId,
                name: metadata.name ?? null,
                preview: metadata.summary?.text ?? '',
                cwd: metadata.path,
                archived: metadata.codexProviderArchived === true,
                createdAt: 0,
                updatedAt: metadata.codexUpdatedAt ?? metadata.summary?.updatedAt ?? 0,
                backfilledUpdatedAt: metadata.codexBackfilledUpdatedAt ?? null,
                source: metadata.codexSource ?? 'unknown',
                status: 'unknown',
            });
            this.rows.set(threadId, previouslyManaged.get(threadId)!);
        }

        // Materialize the complete inventory before transferring any histories.
        // A single large Codex transcript can take minutes to upload, and must not
        // prevent later threads from becoming visible in the phone session list.
        let nextInventoryRow = 0;
        const inventoryWorkers = Array.from(
            { length: Math.min(INVENTORY_CONCURRENCY, providerRows.length) },
            async () => {
                while (nextInventoryRow < providerRows.length) {
                    const providerRow = providerRows[nextInventoryRow++];
                    const isArchived = providerRow.archived;
                    try {
                        const thread = await this.repairPollutedThreadName(providerRow.thread);
                        providerRow.thread = thread;
                        const row = await this.materializeThread(thread, isArchived);
                        this.rows.set(thread.id, row);
                    } catch (error) {
                        logger.debug(`[CODEX CATALOG] Failed to materialize thread ${providerRow.thread.id}`, error);
                    }
                }
            },
        );
        await Promise.all(inventoryWorkers);

        // Delete only mirrors recorded for this machine and CODEX_HOME
        // namespace, including records restored after a daemon restart.
        const staleRows = [...previouslyManaged.entries()]
            .filter(([threadId]) => !seen.has(threadId));
        let nextStaleRow = 0;
        const cleanupWorkers = Array.from(
            { length: Math.min(CLEANUP_CONCURRENCY, staleRows.length) },
            async () => {
                while (nextStaleRow < staleRows.length) {
                    const [threadId, row] = staleRows[nextStaleRow++];
                    const misses = (this.missingReconciliations.get(threadId) ?? 0) + 1;
                    this.missingReconciliations.set(threadId, misses);
                    // Require two consecutive fresh provider inventories before
                    // deleting. This protects sessions registered concurrently
                    // by the VS Code proxy and tolerates one incomplete list.
                    if (misses < 2) continue;
                    try {
                        if (await this.api.deleteSession(row.happySessionId)) {
                            removePersistedSession(row.happySessionId);
                            this.rows.delete(threadId);
                            this.missingReconciliations.delete(threadId);
                        }
                    } catch (error) {
                        logger.debug(`[CODEX CATALOG] Failed to remove archived mirror ${threadId}`, error);
                    }
                }
            }
        );
        await Promise.all(cleanupWorkers);

        this.scheduleHistoryBackfill(providerRows);
        logger.debug(`[CODEX CATALOG] Materialized ${this.rows.size} Codex threads`);
        return this.list();
    }

    private async repairPollutedThreadName(thread: Thread): Promise<Thread> {
        const rawPreview = thread.preview?.trim() || '';
        const cleaned = cleanPreview(thread);
        if (thread.name?.trim() || !cleaned || cleaned === rawPreview) return thread;

        try {
            await (await this.ensureClient()).setThreadName({ threadId: thread.id, name: cleaned });
            return { ...thread, name: cleaned };
        } catch (error) {
            logger.debug(`[CODEX CATALOG] Failed to repair polluted title for ${thread.id}`, error);
            return thread;
        }
    }

    private scheduleHistoryBackfill(
        providerRows: Array<{ thread: Thread; archived: boolean }>,
    ): void {
        if (this.historyBackfillPromise || this.stopped) return;
        this.historyBackfillPromise = this.backfillHistories(providerRows)
            .catch((error) => {
                logger.debug('[CODEX CATALOG] History backfill failed', error);
            })
            .finally(() => {
                this.historyBackfillPromise = null;
            });
    }

    private async backfillHistories(
        providerRows: Array<{ thread: Thread; archived: boolean }>,
    ): Promise<void> {
        let nextHistoryRow = 0;
        const historyWorkers = Array.from(
            { length: Math.min(RECONCILE_CONCURRENCY, providerRows.length) },
            async () => {
                while (!this.stopped && nextHistoryRow < providerRows.length) {
                    const { thread, archived: isArchived } = providerRows[nextHistoryRow++];
                    try {
                        const row = await this.syncThreadHistory(thread, isArchived);
                        this.rows.set(thread.id, row);
                    } catch (error) {
                        logger.debug(`[CODEX CATALOG] Failed to backfill thread ${thread.id}`, error);
                    }
                }
            },
        );
        await Promise.all(historyWorkers);
        logger.debug(`[CODEX CATALOG] Backfilled Codex thread histories`);
    }

    private async resolveHappySession(thread: Thread, archived: boolean): Promise<Session> {
        const { metadata, state } = createSessionMetadata({
            flavor: 'codex',
            machineId: this.machineId,
            startedBy: 'daemon',
        });
        const catalogMetadata = codexCatalogMetadata(metadata, thread, archived);
        return resolveOrCreateCodexSession({
            api: this.api,
            machineId: this.machineId,
            threadId: thread.id,
            metadata: catalogMetadata,
            state,
        });
    }

    private async materializeThread(threadSummary: Thread, archived: boolean): Promise<CodexCatalogThread> {
        const existingRow = this.rows.get(threadSummary.id);
        const summaryRow = catalogRow(
            threadSummary,
            existingRow?.happySessionId ?? '',
            archived,
            existingRow?.backfilledUpdatedAt ?? null,
        );
        if (existingRow
            && existingRow.updatedAt === summaryRow.updatedAt
            && existingRow.archived === summaryRow.archived
            && (existingRow.name ?? existingRow.preview) === (summaryRow.name ?? summaryRow.preview)
            && existingRow.cwd === summaryRow.cwd
            && existingRow.source === summaryRow.source) {
            return summaryRow;
        }

        const session = await this.resolveHappySession(threadSummary, archived);
        const metadata = codexCatalogMetadata(session.metadata, threadSummary, archived);
        const sessionClient = this.api.sessionSyncClient(session);
        sessionClient.skipExistingMessages();
        try {
            await sessionClient.updateMetadataAndWait(() => metadata);
            sessionClient.sendSessionDeath();
        } finally {
            await sessionClient.close();
        }
        const persistedMetadata = sessionClient.getMetadata() ?? metadata;
        persistCodexSession(sessionClient.getSessionSnapshot(), persistedMetadata);
        return catalogRow(
            threadSummary,
            session.id,
            archived,
            persistedMetadata.codexBackfilledUpdatedAt ?? null,
        );
    }

    private async syncThreadHistory(threadSummary: Thread, archived: boolean): Promise<CodexCatalogThread> {
        const existingRow = this.rows.get(threadSummary.id);
        if (existingRow?.backfilledUpdatedAt === timestampMs(threadSummary.updatedAt)) {
            return existingRow;
        }

        const session = await this.resolveHappySession(threadSummary, archived);
        const { thread } = await (await this.ensureClient()).readThread({
            threadId: threadSummary.id,
            includeTurns: true,
        });
        const metadata = codexCatalogMetadata(session.metadata, { ...threadSummary, ...thread }, archived);
        const sessionClient = this.api.sessionSyncClient(session);
        sessionClient.skipExistingMessages();
        try {
            const envelopes = mapCodexThreadToSessionEnvelopes(thread);
            for (const envelope of envelopes) {
                const localId = envelope.role === 'user' && envelope.ev.t === 'text'
                    ? envelope.id
                    : `codex-history:${thread.id}:${envelope.id}`;
                sessionClient.sendSessionProtocolMessageWithLocalId(
                    envelope,
                    localId,
                );
            }
            await sessionClient.flushFully();
            await sessionClient.updateMetadataAndWait((currentMetadata) => ({
                ...currentMetadata,
                codexBackfilledUpdatedAt: timestampMs(thread.updatedAt),
            }));
            sessionClient.sendSessionDeath();
        } finally {
            await sessionClient.close();
        }
        const persistedMetadata = sessionClient.getMetadata() ?? metadata;
        persistCodexSession(sessionClient.getSessionSnapshot(), persistedMetadata);
        return catalogRow(
            { ...threadSummary, ...thread },
            session.id,
            archived,
            persistedMetadata.codexBackfilledUpdatedAt ?? null,
        );
    }
}
