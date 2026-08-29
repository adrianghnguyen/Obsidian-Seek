import type { App } from 'obsidian';
import type { SeekLogger } from '../../logger';
import type { SearchOrchestrator } from '../../search';
import { SeekSearchModal } from '../../search-modal';
import { DEFAULT_SETTINGS, type ScoredChunk } from '../../types';
import type { IndexLoadState } from '../../index-notice';

interface ModalInternals {
    lastQuery: string;
    currentResults: ScoredChunk[];
    loadKind: string;
    lastChunkCount: number | null;
    lastJobRemaining: number | null;
    checkIndexState(): Promise<void>;
    runSearch(query: string): Promise<void>;
    syncFooterStatus(): void;
    renderEmptyQuery(kind: string): void;
}

/**
 * Exercises the real modal's index polling decision without constructing a DOM.
 * Rendering is replaced by counters; query retry behavior remains production code.
 */
export class ModalResponseHarness {
    private chunks = 0;
    private phase: IndexLoadState['phase'] = 'hydrating';
    readonly retriedQueries: string[] = [];
    statusRenders = 0;

    private readonly modal: ModalInternals;

    constructor() {
        const orchestrator = {
            indexedChunkCount: async () => this.chunks,
            warmCaches: async () => {},
        } as unknown as SearchOrchestrator;
        const logger = {
            append: async () => {},
            appendError: async () => {},
        } as unknown as SeekLogger;
        const loadState = (): IndexLoadState => ({
            phase: this.phase,
            catchUpPending: false,
            waitingForSidecar: false,
        });
        const modal = new SeekSearchModal(
            {} as App,
            orchestrator,
            logger,
            { ready: true, promise: Promise.resolve() },
            structuredClone(DEFAULT_SETTINGS),
            undefined,
            undefined,
            undefined,
            loadState,
        ) as unknown as ModalInternals;

        modal.runSearch = async query => {
            this.retriedQueries.push(query);
        };
        modal.syncFooterStatus = () => {};
        modal.renderEmptyQuery = () => {
            this.statusRenders++;
        };
        this.modal = modal;
    }

    primeWaitingQuery(query: string): void {
        this.modal.lastQuery = query;
        this.modal.currentResults = [];
        this.modal.loadKind = 'starting';
        this.modal.lastChunkCount = 0;
        this.modal.lastJobRemaining = null;
    }

    async commitFirstChunkAndPoll(): Promise<void> {
        this.chunks = 1;
        this.phase = 'idle';
        await this.modal.checkIndexState();
    }
}
