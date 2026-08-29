import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions },
}));

// ops.ts imports storage (for sessionSetAgentModes), which transitively pulls
// in react-native — mock it out, these tests never touch it.
vi.mock('./storage', () => ({
    storage: { getState: vi.fn(() => ({ sessions: {} })) },
}));

describe('codex fork ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('passes new-session mode defaults through spawn RPC', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-new' });

        const { machineSpawnNewSession } = await import('./ops');
        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp/project',
            agent: 'claude',
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: 'xhigh',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-new' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                directory: '/tmp/project',
                agent: 'claude',
                permissionMode: 'bypassPermissions',
                modelMode: 'opus',
                effortLevel: 'xhigh',
            }),
        );
    });

    it('routes catalog sync and thread mutations to the local machine daemon', async () => {
        machineRPC
            .mockResolvedValueOnce({ type: 'success', threads: [] })
            .mockResolvedValue({ type: 'success' });

        const {
            codexArchiveThread,
            codexCatalogSync,
            codexDeleteThread,
            codexRenameThread,
            codexUnarchiveThread,
        } = await import('./ops');

        await expect(codexCatalogSync('machine-1')).resolves.toEqual({ type: 'success', threads: [] });
        await codexRenameThread('machine-1', 'thread-1', 'New title');
        await codexArchiveThread('machine-1', 'thread-1');
        await codexUnarchiveThread('machine-1', 'thread-1');
        await codexDeleteThread('machine-1', 'thread-1');

        expect(machineRPC.mock.calls).toEqual([
            ['machine-1', 'codex-catalog-sync', {}],
            ['machine-1', 'codex-thread-rename', { threadId: 'thread-1', name: 'New title' }],
            ['machine-1', 'codex-thread-archive', { threadId: 'thread-1' }],
            ['machine-1', 'codex-thread-unarchive', { threadId: 'thread-1' }],
            ['machine-1', 'codex-thread-delete', { threadId: 'thread-1' }],
        ]);
    });

    it('forks a full Codex thread and spawns a Codex session resumed to the new thread', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-forked' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-forked' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-fork-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                directory: '/tmp/project',
                resumeCodexThreadId: 'thread-forked',
                parentSessionId: 'happy-source',
            }),
        );
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('duplicates a Codex thread from a selected user item before spawning', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-duplicate-thread') {
                return { type: 'success', newCodexThreadId: 'thread-cut' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-cut' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        }, {
            cutAfterItemId: 'user-item-2',
            forkedFromMessageId: 'message-2',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-cut' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-duplicate-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source', cutAfterItemId: 'user-item-2' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                resumeCodexThreadId: 'thread-cut',
                forkedFromMessageId: 'message-2',
            }),
        );
    });
});
