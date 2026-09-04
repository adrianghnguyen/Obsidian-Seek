import { describe, it, expect, vi } from 'vitest';
import type { App, DataAdapter } from 'obsidian';
import { TFile } from 'obsidian';
import {
    REPORT_PATH,
    REPORT_JSON_PATH,
    REPORT_ARTIFACTS_DIR,
    LEGACY_REPORT_JSON_PATH,
    ensureArtifactsDir,
    migrateLegacyReportJson,
    buildReportData,
    summarizeReport,
    writeDiagnosticReport,
    openDiagnosticReport,
    type DiagnosticLoggerHost,
    type ReportData,
} from './diagnostic-report';
import type { LogEntry } from './types';

class FakeAdapter {
    files = new Map<string, string>();

    async exists(p: string): Promise<boolean> {
        return this.files.has(p);
    }
    async mkdir(_p: string): Promise<void> {
        this.files.set(_p, '');
    }
    async read(p: string): Promise<string> {
        const v = this.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    }
    async write(p: string, data: string): Promise<void> {
        this.files.set(p, data);
    }
    async append(p: string, data: string): Promise<void> {
        const prev = this.files.get(p) ?? '';
        this.files.set(p, prev + data);
    }
    async remove(p: string): Promise<void> {
        this.files.delete(p);
    }
    async rename(from: string, to: string): Promise<void> {
        const v = this.files.get(from);
        if (v === undefined) throw new Error(`ENOENT ${from}`);
        this.files.set(to, v);
        this.files.delete(from);
    }
    async stat(p: string): Promise<{ size: number; type: 'file' } | null> {
        const v = this.files.get(p);
        return v === undefined ? null : { size: v.length, type: 'file' };
    }
    async list(dir: string): Promise<{ folders: string[]; files: string[] }> {
        const prefix = dir.endsWith('/') || dir === '' ? dir : dir + '/';
        const files = [...this.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        return { folders: [], files };
    }
}

function makeFakeApp(adapter: FakeAdapter, abstractFiles: Map<string, unknown> = new Map()): App {
    const openedFiles: TFile[] = [];
    return {
        vault: {
            adapter: adapter as unknown as DataAdapter,
            getAbstractFileByPath: (p: string) => abstractFiles.get(p) ?? null,
        },
        workspace: {
            getLeaf: (_create?: boolean) => ({
                openFile: async (file: TFile) => { openedFiles.push(file); },
            }),
        },
        _openedFiles: openedFiles,
    } as unknown as App;
}

function makeFakeLogger(app: App, entries: LogEntry[] = []): DiagnosticLoggerHost & { flushed: boolean; appendedErrors: Array<{ ctx: string; err: unknown }> } {
    const appendedErrors: Array<{ ctx: string; err: unknown }> = [];
    return {
        app,
        deviceId: 'device-test-1',
        sessionId: 'session-test-1',
        flushed: false,
        appendedErrors,
        async flushErrorAggregates(): Promise<void> {
            this.flushed = true;
        },
        async readAllDevices(): Promise<LogEntry[]> {
            return [...entries];
        },
        async appendError(ctx: string, err: unknown): Promise<void> {
            appendedErrors.push({ ctx, err });
        },
    };
}

describe('diagnostic-report module', () => {
    it('ensureArtifactsDir creates dir when missing', async () => {
        const adapter = new FakeAdapter();
        const app = makeFakeApp(adapter);
        expect(await adapter.exists(REPORT_ARTIFACTS_DIR)).toBe(false);

        await ensureArtifactsDir(app);
        expect(await adapter.exists(REPORT_ARTIFACTS_DIR)).toBe(true);
    });

    it('migrateLegacyReportJson moves legacy root report JSON into artifacts dir', async () => {
        const adapter = new FakeAdapter();
        const app = makeFakeApp(adapter);
        await adapter.write(LEGACY_REPORT_JSON_PATH, '{"old": true}');

        await migrateLegacyReportJson(app);
        expect(await adapter.exists(LEGACY_REPORT_JSON_PATH)).toBe(false);
        expect(await adapter.exists(REPORT_JSON_PATH)).toBe(true);
        expect(await adapter.read(REPORT_JSON_PATH)).toBe('{"old": true}');
    });

    it('buildReportData aggregates entries and caps high-volume types', async () => {
        const adapter = new FakeAdapter();
        const app = makeFakeApp(adapter);
        const entries: LogEntry[] = [];
        for (let i = 0; i < 200; i++) {
            entries.push({
                type: 'search',
                timestamp: new Date(1000000 + i * 1000).toISOString(),
                deviceId: 'device-test-1',
                query: `query-${i}`,
                fusedTop50: ['c1', 'c2'],
            } as unknown as LogEntry);
        }

        const logger = makeFakeLogger(app, entries);
        const report = await buildReportData(logger, false);

        expect(logger.flushed).toBe(true);
        expect(report.thisDevice).toBe('device-test-1');
        expect(report.thisSession).toBe('session-test-1');
        expect(report.entryCount).toBe(200);
        expect(report.includedCount).toBe(150); // search capped at 150
        expect(report.redacted).toBe(false);
        expect(report.devices).toEqual([{ id: 'device-test-1', count: 200 }]);
    });

    it('summarizeReport produces informative human-readable markdown', () => {
        const data: ReportData = {
            generated: '2026-09-04T04:00:00.000Z',
            schemaVersion: 1,
            thisDevice: 'device-test-1',
            thisSession: 'session-test-1',
            entryCount: 5,
            includedCount: 5,
            firstTimestamp: '2026-09-04T03:00:00.000Z',
            lastTimestamp: '2026-09-04T04:00:00.000Z',
            devices: [{ id: 'device-test-1', count: 5 }],
            caps: { search: 150 },
            redacted: false,
            entries: [
                { type: 'init', pluginVersion: '1.4.0', iframeReady: true, timestamp: '2026-09-04T03:00:00.000Z' } as LogEntry,
                { type: 'platform', isMobile: false, gpuAvailable: true, storageUsedMB: 50, storageQuotaMB: 500, timestamp: '2026-09-04T03:00:01.000Z' } as LogEntry,
                { type: 'load', actualDevice: 'webgpu', dtype: 'fp32', timestamp: '2026-09-04T03:00:02.000Z' } as LogEntry,
                { type: 'search', timestamp: '2026-09-04T03:05:00.000Z', query: 'notes' } as LogEntry,
                { type: 'error', context: 'worker', message: 'test failure', timestamp: '2026-09-04T03:10:00.000Z' } as LogEntry,
            ],
        };

        const md = summarizeReport(data);
        expect(md).toContain('# Seek Diagnostic Report');
        expect(md).toContain('Review before sharing');
        expect(md).toContain('device-test-1');
        expect(md).toContain('v1.4.0');
        expect(md).toContain('desktop · GPU yes');
        expect(md).toContain('webgpu (dtype=fp32)');
        expect(md).toContain('Searches 1');
        expect(md).toContain('Recent Errors');
        expect(md).toContain('`worker` — test failure');
    });

    it('writeDiagnosticReport writes both seek-report.json and seek-report.md', async () => {
        const adapter = new FakeAdapter();
        const app = makeFakeApp(adapter);
        const logger = makeFakeLogger(app, [
            { type: 'search', query: 'secret plans', timestamp: new Date().toISOString() } as LogEntry,
        ]);

        const path = await writeDiagnosticReport(logger, true);
        expect(path).toBe(REPORT_PATH);
        expect(await adapter.exists(REPORT_PATH)).toBe(true);
        expect(await adapter.exists(REPORT_JSON_PATH)).toBe(true);

        const json = JSON.parse(await adapter.read(REPORT_JSON_PATH));
        expect(json.redacted).toBe(true);
        const md = await adapter.read(REPORT_PATH);
        expect(md).toContain('Redacted report');
    });

    it('openDiagnosticReport writes report and opens file in workspace leaf', async () => {
        const adapter = new FakeAdapter();
        const fakeFile = new (TFile as unknown as { new(path: string): TFile })('seek-report.md');
        const abstractFiles = new Map<string, unknown>([['seek-report.md', fakeFile]]);
        const app = makeFakeApp(adapter, abstractFiles);
        const logger = makeFakeLogger(app, []);

        const resultPath = await openDiagnosticReport({
            app,
            logger,
            redactReport: false,
        });

        expect(resultPath).toBe(REPORT_PATH);
        expect((app as unknown as { _openedFiles: TFile[] })._openedFiles).toContain(fakeFile);
    });

    it('openDiagnosticReport handles errors gracefully by recording error and displaying notice', async () => {
        const adapter = new FakeAdapter();
        const app = makeFakeApp(adapter);
        const logger = makeFakeLogger(app, []);
        // Force an error by mocking write to throw
        adapter.write = vi.fn().mockRejectedValue(new Error('disk full'));

        const resultPath = await openDiagnosticReport({
            app,
            logger,
            redactReport: false,
        });

        expect(resultPath).toBeNull();
        expect(logger.appendedErrors.length).toBe(1);
        expect(logger.appendedErrors[0].ctx).toBe('generate-log');
    });
});
