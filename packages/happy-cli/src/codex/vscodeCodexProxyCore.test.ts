import { describe, expect, it, vi } from 'vitest';

import { VscodeCodexProxyCore, mapCodexNotificationToEnvelopes } from './vscodeCodexProxyCore';

function createHarness() {
    const writeToCodex = vi.fn();
    const writeToVscode = vi.fn();
    const registerThread = vi.fn();
    const mirrorUserTurn = vi.fn();
    const mirrorNotification = vi.fn();
    const proxy = new VscodeCodexProxyCore({
        writeToCodex,
        writeToVscode,
        registerThread,
        mirrorUserTurn,
        mirrorNotification,
    });
    return { proxy, writeToCodex, writeToVscode, registerThread, mirrorUserTurn, mirrorNotification };
}

describe('VscodeCodexProxyCore', () => {
    it('forwards VS Code traffic and registers the returned Codex thread', () => {
        const harness = createHarness();
        harness.proxy.fromVscode({ id: 1, method: 'thread/start', params: { cwd: '/repo' } });
        harness.proxy.fromCodex({ id: 1, result: { thread: { id: 'thread-1' } } });

        expect(harness.writeToCodex).toHaveBeenCalledWith({ id: 1, method: 'thread/start', params: { cwd: '/repo' } });
        expect(harness.writeToVscode).toHaveBeenCalledWith({ id: 1, result: { thread: { id: 'thread-1' } } });
        expect(harness.registerThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    });

    it('registers a fork response as the new thread rather than the source thread', () => {
        const harness = createHarness();
        harness.proxy.fromVscode({
            id: 8,
            method: 'thread/fork',
            params: { threadId: 'source-thread', cwd: '/repo' },
        });
        expect(harness.registerThread).not.toHaveBeenCalled();

        harness.proxy.fromCodex({ id: 8, result: { thread: { id: 'forked-thread' } } });
        expect(harness.registerThread).toHaveBeenCalledWith({ threadId: 'forked-thread', cwd: '/repo' });
    });

    it('does not mirror Codex ephemeral helper threads as phone sessions', () => {
        const harness = createHarness();
        harness.proxy.fromVscode({
            id: 9,
            method: 'thread/start',
            params: { cwd: '/repo', ephemeral: true },
        });
        harness.proxy.fromCodex({
            id: 9,
            result: { thread: { id: 'helper-response-thread', cwd: '/repo', ephemeral: true } },
        });
        harness.proxy.fromCodex({
            method: 'thread/started',
            params: { thread: { id: 'helper-thread', cwd: '/repo', ephemeral: true } },
        });

        expect(harness.registerThread).not.toHaveBeenCalled();
        expect(harness.mirrorNotification).not.toHaveBeenCalled();
    });

    it('mirrors local prompts and starts an idle turn from a mobile message', () => {
        const harness = createHarness();
        harness.proxy.fromVscode({
            id: 2,
            method: 'turn/start',
            params: {
                threadId: 'thread-1',
                cwd: '/repo',
                model: 'gpt-test',
                input: [{ type: 'text', text: 'from vscode' }],
            },
        });
        harness.proxy.sendMobileText('thread-1', 'from phone', 'phone-message-1');

        expect(harness.mirrorUserTurn).toHaveBeenCalledWith({
            threadId: 'thread-1',
            text: 'from vscode',
            requestId: 2,
            messageId: 'vscode-request:2',
        });
        const injected = harness.writeToCodex.mock.calls.at(-1)?.[0];
        expect(injected.method).toBe('turn/start');
        expect(injected.params).toMatchObject({
            threadId: 'thread-1',
            cwd: '/repo',
            model: 'gpt-test',
            clientUserMessageId: 'phone-message-1',
            input: [{ type: 'text', text: 'from phone', text_elements: [] }],
        });
    });

    it('steers an active turn and swallows only the injected response', () => {
        const harness = createHarness();
        harness.proxy.fromCodex({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        });
        harness.proxy.sendMobileText('thread-1', 'change direction');
        const injected = harness.writeToCodex.mock.calls.at(-1)?.[0];

        expect(injected).toMatchObject({
            method: 'turn/steer',
            params: { threadId: 'thread-1', expectedTurnId: 'turn-1' },
        });
        harness.proxy.fromCodex({ id: injected.id, result: {} });
        expect(harness.writeToVscode).not.toHaveBeenCalledWith({ id: injected.id, result: {} });
    });

    it('maps /abort to turn/interrupt for the current turn', () => {
        const harness = createHarness();
        harness.proxy.fromCodex({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-9' } },
        });
        harness.proxy.sendMobileText('thread-1', '/abort');

        expect(harness.writeToCodex.mock.calls.at(-1)?.[0]).toMatchObject({
            method: 'turn/interrupt',
            params: { threadId: 'thread-1', turnId: 'turn-9' },
        });
    });

    it('archives only the selected mobile thread and allows a later resume to re-register it', () => {
        const harness = createHarness();
        harness.proxy.fromVscode({ id: 1, method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/repo' } });
        harness.proxy.fromCodex({ id: 1, result: { thread: { id: 'thread-1' } } });

        harness.proxy.archiveMobileThread('thread-1');
        expect(harness.writeToCodex.mock.calls.at(-1)?.[0]).toMatchObject({
            method: 'thread/archive',
            params: { threadId: 'thread-1' },
        });

        harness.proxy.fromVscode({ id: 2, method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/repo' } });
        harness.proxy.fromCodex({ id: 2, result: { thread: { id: 'thread-1' } } });
        expect(harness.registerThread).toHaveBeenCalledTimes(2);
    });
});

describe('mapCodexNotificationToEnvelopes', () => {
    it('uses replay-compatible IDs for turn and tool events', () => {
        expect(mapCodexNotificationToEnvelopes({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        })[0]?.id).toBe('turn-1:start');
        expect(mapCodexNotificationToEnvelopes({
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { type: 'commandExecution', id: 'tool-1', command: 'pwd' },
            },
        })[0]?.id).toBe('tool-1:start');
        expect(mapCodexNotificationToEnvelopes({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { type: 'commandExecution', id: 'tool-1', command: 'pwd' },
            },
        })[0]?.id).toBe('tool-1:end');
        expect(mapCodexNotificationToEnvelopes({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })[0]?.id).toBe('turn-1:end');
    });

    it('mirrors final answers without duplicating streaming deltas', () => {
        expect(mapCodexNotificationToEnvelopes({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'partial' },
        })).toEqual([]);

        const envelopes = mapCodexNotificationToEnvelopes({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { type: 'agentMessage', id: 'item-1', text: 'final answer' },
            },
        });
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]).toMatchObject({
            id: 'item-1',
            role: 'agent',
            turn: 'turn-1',
            codexItemId: 'item-1',
            ev: { t: 'text', text: 'final answer' },
        });
    });
});
