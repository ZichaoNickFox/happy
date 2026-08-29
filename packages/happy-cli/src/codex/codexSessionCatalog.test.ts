import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { codexCatalogMetadata } from './codexSessionCatalog';

const baseMetadata = {
    flavor: 'codex',
    path: '/old',
    host: 'test-host',
    machineId: 'machine-1',
    startedBy: 'daemon',
} as Metadata;

describe('codexCatalogMetadata', () => {
    it('maps a local provider thread into an unarchived Happy catalog session', () => {
        const metadata = codexCatalogMetadata(baseMetadata, {
            id: 'thread-1',
            name: 'Named session',
            preview: 'preview',
            cwd: '/repo',
            source: 'vscode',
            updatedAt: 1_700_000_000,
        }, false);

        expect(metadata).toMatchObject({
            name: 'Named session',
            path: '/repo',
            codexThreadId: 'thread-1',
            codexCatalogManaged: true,
            codexCatalogNamespace: expect.any(String),
            codexProviderArchived: false,
            codexSource: 'vscode',
            codexUpdatedAt: 1_700_000_000_000,
            lifecycleState: 'running',
        });
    });

    it('falls back to the preview and preserves provider archive state', () => {
        const metadata = codexCatalogMetadata(baseMetadata, {
            id: 'thread-2',
            preview: 'Historical prompt',
            cwd: '/repo',
            source: 'cli',
        }, true);

        expect(metadata).toMatchObject({
            name: 'Historical prompt',
            codexProviderArchived: true,
            lifecycleState: 'archived',
            archivedBy: 'codex',
        });
    });

    it('strips Happy scaffolding from legacy Codex previews', () => {
        const metadata = codexCatalogMetadata(baseMetadata, {
            id: 'thread-3',
            preview: '<happy-system>\n# Options\n</happy-system>\n\nActual user request\n\n<happy-system>\nrename this\n</happy-system>',
            cwd: '/repo',
            source: 'cli',
        }, false);

        expect(metadata.name).toBe('Actual user request');
        expect(metadata.summary?.text).toBe('Actual user request');
    });
});
