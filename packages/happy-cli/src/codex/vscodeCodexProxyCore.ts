import { randomUUID } from 'node:crypto';

import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

export type JsonRpcId = number | string;

export type JsonRpcMessage = {
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
};

export type ThreadRegistration = {
    threadId: string;
    cwd: string;
};

export type MirroredUserTurn = {
    threadId: string;
    text: string;
    requestId: JsonRpcId;
    messageId: string;
};

export type ProxyHooks = {
    writeToCodex: (message: JsonRpcMessage) => void;
    writeToVscode: (message: JsonRpcMessage) => void;
    registerThread: (registration: ThreadRegistration) => void;
    mirrorUserTurn: (turn: MirroredUserTurn) => void;
    mirrorNotification: (threadId: string, envelopes: SessionEnvelope[]) => void;
};

type PendingRequest = {
    method: string;
    params: Record<string, unknown>;
    injected: boolean;
};

const RECENT_THREAD_LIST_PARAMS = {
    archived: false,
    limit: 100,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractThreadId(message: JsonRpcMessage): string | null {
    const params = record(message.params);
    const direct = nonEmptyString(params?.threadId);
    if (direct) return direct;

    const thread = record(params?.thread);
    return nonEmptyString(thread?.id);
}

function extractResultThreadId(result: unknown): string | null {
    const resultRecord = record(result);
    const thread = record(resultRecord?.thread);
    return nonEmptyString(thread?.id);
}

function resultThreadIsEphemeral(result: unknown): boolean {
    const resultRecord = record(result);
    return record(resultRecord?.thread)?.ephemeral === true;
}

function extractResultTurnId(result: unknown): string | null {
    const resultRecord = record(result);
    const turn = record(resultRecord?.turn);
    return nonEmptyString(turn?.id);
}

function extractResultThreads(result: unknown): Record<string, unknown>[] {
    const data = record(result)?.data;
    return Array.isArray(data)
        ? data.map(record).filter((thread): thread is Record<string, unknown> => thread !== null)
        : [];
}

function threadListFingerprint(thread: Record<string, unknown>): string {
    return JSON.stringify([
        thread.name,
        thread.preview,
        thread.recencyAt ?? thread.updatedAt,
    ]);
}

function extractTurnId(params: Record<string, unknown> | undefined): string | null {
    const turn = record(params?.turn);
    return nonEmptyString(turn?.id) ?? nonEmptyString(params?.turnId);
}

export function extractTextInput(params: Record<string, unknown> | undefined): string {
    const input = params?.input;
    if (!Array.isArray(input)) return '';

    return input
        .map((item) => {
            const itemRecord = record(item);
            return itemRecord?.type === 'text' && typeof itemRecord.text === 'string'
                ? itemRecord.text
                : '';
        })
        .filter(Boolean)
        .join('\n');
}

function turnStatus(params: Record<string, unknown> | undefined): 'completed' | 'failed' | 'cancelled' {
    const turn = record(params?.turn);
    const status = nonEmptyString(turn?.status) ?? nonEmptyString(params?.status);
    if (status === 'failed') return 'failed';
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
}

function toolTitle(item: Record<string, unknown>): string {
    if (item.type === 'commandExecution') {
        return nonEmptyString(item.command) ?? 'Run command';
    }
    if (item.type === 'fileChange') return 'Edit files';
    if (item.type === 'mcpToolCall') {
        return [nonEmptyString(item.server), nonEmptyString(item.tool)].filter(Boolean).join(': ') || 'MCP tool';
    }
    return nonEmptyString(item.type) ?? 'Tool';
}

function toolName(item: Record<string, unknown>): string {
    if (item.type === 'commandExecution') return 'CodexBash';
    if (item.type === 'fileChange') return 'CodexPatch';
    if (item.type === 'mcpToolCall') return nonEmptyString(item.tool) ?? 'McpTool';
    return nonEmptyString(item.type) ?? 'CodexTool';
}

export function mapCodexNotificationToEnvelopes(message: JsonRpcMessage): SessionEnvelope[] {
    const method = message.method;
    const params = record(message.params) ?? undefined;
    const turnId = extractTurnId(params) ?? undefined;

    if (method === 'turn/started') {
        return [createEnvelope('agent', { t: 'turn-start' }, {
            id: turnId ? `${turnId}:start` : undefined,
            turn: turnId,
        })];
    }

    if (method === 'turn/completed') {
        return [createEnvelope('agent', {
            t: 'turn-end',
            status: turnStatus(params),
        }, {
            id: turnId ? `${turnId}:end` : undefined,
            turn: turnId,
        })];
    }

    if (method !== 'item/started' && method !== 'item/completed') {
        return [];
    }

    const item = record(params?.item);
    if (!item) return [];
    const itemId = nonEmptyString(item.id) ?? randomUUID();

    if (method === 'item/completed' && item.type === 'agentMessage') {
        const text = nonEmptyString(item.text);
        return text
            ? [createEnvelope('agent', { t: 'text', text }, {
                id: itemId,
                turn: turnId,
                codexItemId: itemId,
            })]
            : [];
    }

    if (method === 'item/completed' && item.type === 'reasoning') {
        const summary = Array.isArray(item.summary)
            ? item.summary.filter((part): part is string => typeof part === 'string').join('\n')
            : '';
        return summary
            ? [createEnvelope('agent', { t: 'text', text: summary, thinking: true }, {
                id: itemId,
                turn: turnId,
                codexItemId: itemId,
            })]
            : [];
    }

    const isTool = item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall';
    if (!isTool) return [];

    if (method === 'item/started') {
        return [createEnvelope('agent', {
            t: 'tool-call-start',
            call: itemId,
            name: toolName(item),
            title: toolTitle(item),
            description: toolTitle(item),
            args: item,
        }, {
            id: `${itemId}:start`,
            turn: turnId,
            codexItemId: itemId,
        })];
    }

    return [createEnvelope('agent', { t: 'tool-call-end', call: itemId }, {
        id: `${itemId}:end`,
        turn: turnId,
        codexItemId: itemId,
    })];
}

/**
 * Multiplexes Happy-originated JSON-RPC requests onto the exact app-server
 * connection owned by the official VS Code Codex extension.
 */
export class VscodeCodexProxyCore {
    private readonly pending = new Map<JsonRpcId, PendingRequest>();
    private readonly threadCwds = new Map<string, string>();
    private readonly lastTurnParams = new Map<string, Record<string, unknown>>();
    private readonly activeTurns = new Map<string, string>();
    private readonly visibleThreadFingerprints = new Map<string, string>();
    private initialized = false;
    private threadListRefreshPending = false;
    private injectedSequence = 0;

    constructor(private readonly hooks: ProxyHooks) {}

    fromVscode(message: JsonRpcMessage): void {
        if (message.id !== undefined && message.method) {
            const params = record(message.params) ?? {};
            this.pending.set(message.id, { method: message.method, params, injected: false });

            const threadId = nonEmptyString(params.threadId);
            if (message.method === 'turn/start' && threadId) {
                this.registerThread(threadId, nonEmptyString(params.cwd) ?? process.cwd());
                this.lastTurnParams.set(threadId, structuredClone(params));
                const text = extractTextInput(params);
                if (text) {
                    this.hooks.mirrorUserTurn({
                        threadId,
                        text,
                        requestId: message.id,
                        messageId: nonEmptyString(params.clientUserMessageId) ?? `vscode-request:${message.id}`,
                    });
                }
            }

        }

        this.hooks.writeToCodex(message);
        if (message.method === 'initialized') this.initialized = true;
    }

    fromCodex(message: JsonRpcMessage): void {
        if (message.id !== undefined && !message.method) {
            const pending = this.pending.get(message.id);
            if (pending) {
                this.pending.delete(message.id);
                this.handleResponse(message, pending);
                if (pending.injected) return;
            }
        }

        if (message.method) {
            this.handleNotification(message);
        }

        this.hooks.writeToVscode(message);
    }

    sendMobileText(threadId: string, text: string, clientUserMessageId?: string): void {
        const trimmed = text.trim();
        if (!trimmed) return;

        if (trimmed === '/abort') {
            const activeTurnId = this.activeTurns.get(threadId);
            if (activeTurnId) {
                this.inject('turn/interrupt', { threadId, turnId: activeTurnId });
            }
            return;
        }

        const input = [{ type: 'text', text, text_elements: [] }];
        const activeTurnId = this.activeTurns.get(threadId);
        if (activeTurnId) {
            this.inject('turn/steer', { threadId, expectedTurnId: activeTurnId, input });
            return;
        }

        const previous = this.lastTurnParams.get(threadId) ?? {};
        this.inject('turn/start', {
            ...structuredClone(previous),
            threadId,
            clientUserMessageId: clientUserMessageId ?? `happy-mobile-${randomUUID()}`,
            input,
        });
    }

    refreshVisibleThreads(): void {
        if (!this.initialized || this.threadListRefreshPending) return;
        this.threadListRefreshPending = true;
        this.inject('thread/list', RECENT_THREAD_LIST_PARAMS);
    }

    /**
     * Archive one VS Code thread and detach its Happy mobile bridge without
     * stopping the shared app-server process that may own other threads.
     */
    archiveMobileThread(threadId: string): void {
        if (!this.threadCwds.has(threadId)) return;
        this.inject('thread/archive', { threadId });
        this.threadCwds.delete(threadId);
        this.lastTurnParams.delete(threadId);
        this.activeTurns.delete(threadId);
    }

    private inject(method: string, params: Record<string, unknown>): void {
        const id = `happy-vscode-${++this.injectedSequence}-${randomUUID()}`;
        this.pending.set(id, { method, params, injected: true });
        this.hooks.writeToCodex({ id, method, params });
    }

    private handleResponse(message: JsonRpcMessage, pending: PendingRequest): void {
        if (pending.method === 'thread/list') {
            if (pending.injected) this.threadListRefreshPending = false;
            if (!message.error) this.handleThreadList(message.result, pending.injected);
        }
        if (message.error) return;

        if (pending.method === 'thread/start' || pending.method === 'thread/resume' || pending.method === 'thread/fork') {
            if (pending.params.ephemeral === true || resultThreadIsEphemeral(message.result)) return;
            const threadId = extractResultThreadId(message.result) ?? nonEmptyString(pending.params.threadId);
            if (threadId) {
                this.registerThread(threadId, nonEmptyString(pending.params.cwd) ?? process.cwd());
            }
        }

        if ((pending.method === 'turn/start' || pending.method === 'turn/steer') && pending.injected) {
            const threadId = nonEmptyString(pending.params.threadId);
            const turnId = extractResultTurnId(message.result);
            if (threadId && turnId) this.activeTurns.set(threadId, turnId);
        }
    }

    private handleNotification(message: JsonRpcMessage): void {
        const threadId = extractThreadId(message);
        if (!threadId) return;

        if (message.method === 'thread/started') {
            const params = record(message.params);
            const thread = record(params?.thread);
            // Codex creates ephemeral helper threads for work such as title
            // generation. They are not provider sessions and must not appear as
            // separate conversations on the phone.
            if (thread?.ephemeral === true) return;
            if (thread) this.rememberVisibleThread(thread);
            this.registerThread(threadId, nonEmptyString(thread?.cwd) ?? this.threadCwds.get(threadId) ?? process.cwd());
        }

        if (message.method === 'turn/started') {
            const turnId = extractTurnId(record(message.params) ?? undefined);
            if (turnId) this.activeTurns.set(threadId, turnId);
        } else if (message.method === 'turn/completed') {
            this.activeTurns.delete(threadId);
        }

        const envelopes = mapCodexNotificationToEnvelopes(message);
        if (envelopes.length > 0) {
            this.hooks.mirrorNotification(threadId, envelopes);
        }
    }

    private registerThread(threadId: string, cwd: string): void {
        if (this.threadCwds.has(threadId)) return;
        this.threadCwds.set(threadId, cwd);
        this.hooks.registerThread({ threadId, cwd });
    }

    private handleThreadList(result: unknown, injected: boolean): void {
        for (const thread of extractResultThreads(result)) {
            const threadId = nonEmptyString(thread.id);
            if (!threadId || thread.ephemeral === true) continue;
            const fingerprint = threadListFingerprint(thread);
            const changed = this.visibleThreadFingerprints.get(threadId) !== fingerprint;
            this.visibleThreadFingerprints.set(threadId, fingerprint);
            if (injected && changed) {
                // Another Codex app-server may have created this thread from
                // Happy mobile. The official VS Code UI only refreshes its
                // in-memory list when it receives a standard lifecycle event.
                this.hooks.writeToVscode({
                    method: 'thread/started',
                    params: { thread },
                });
            }
        }
    }

    private rememberVisibleThread(thread: Record<string, unknown>): void {
        const threadId = nonEmptyString(thread.id);
        if (threadId) this.visibleThreadFingerprints.set(threadId, threadListFingerprint(thread));
    }
}
