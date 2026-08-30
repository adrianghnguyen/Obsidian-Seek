import type { App } from 'obsidian';
import type { SeekLogger } from '../../logger';
import type { SearchOrchestrator } from '../../search';
import { SeekSearchModal } from '../../search-modal';
import { DEFAULT_SETTINGS, type ScoredChunk } from '../../types';
import type { IndexLoadKind, IndexLoadState, IndexUiStatus } from '../../index-notice';
import { isIndexWaitKind } from '../../index-notice';

interface ModalInternals {
    lastQuery: string;
    currentResults: ScoredChunk[];
    loadKind: IndexLoadKind;
    lastChunkCount: number | null;
    lastJobRemaining: number | null;
    checkIndexState(): Promise<void>;
    runSearch(query: string): Promise<void>;
    syncFooterStatus(): void;
    renderEmptyQuery(kind: IndexLoadKind): void;
    renderIndexWait(spec: { kind: IndexLoadKind }): void;
}

/**
 * Modal contract harness — drives checkIndexState / renderEmptyQuery with
 * configurable uiHealth and chunk probe, without DOM.
 */
export class ModalReadyContractHarness {
    private chunks: number | null = null;
    private loadState: IndexLoadState = { phase: 'idle' };
    private _waitRenders = 0;

    private readonly modal: ModalInternals;

    constructor() {
        const self = this;
        const orchestrator = {
            indexedChunkCount: async () => self.chunks,
            warmCaches: async () => {},
        } as unknown as SearchOrchestrator;
        const logger = {
            append: async () => {},
            appendError: async () => {},
        } as unknown as SeekLogger;
        const modal = new SeekSearchModal(
            {} as App,
            orchestrator,
            logger,
            { ready: true, promise: Promise.resolve() },
            structuredClone(DEFAULT_SETTINGS),
            undefined,
            undefined,
            undefined,
            () => self.loadState,
        ) as unknown as ModalInternals;

        modal.runSearch = async () => {};
        modal.syncFooterStatus = () => {};
        modal.renderEmptyQuery = kind => {
            if (isIndexWaitKind(kind)) self._waitRenders++;
        };
        modal.renderIndexWait = () => {
            self._waitRenders++;
        };
        this.modal = modal;
    }

    get loadKind(): IndexLoadKind {
        return this.modal.loadKind;
    }

    get waitRenders(): number {
        return this._waitRenders;
    }

    setModalChunks(n: number | null): void {
        this.chunks = n;
    }

    setLoadState(state: {
        phase: IndexLoadState['phase'];
        uiHealth?: IndexUiStatus;
        job?: IndexLoadState['job'];
        catchUpPending?: boolean;
    }): void {
        this.loadState = {
            phase: state.phase,
            uiHealth: state.uiHealth,
            job: state.job ?? null,
            catchUpPending: state.catchUpPending ?? false,
            waitingForSidecar: false,
        };
    }

    primeQuery(q: string): void {
        this.modal.lastQuery = q;
        this.modal.currentResults = [];
        this.modal.loadKind = 'resting';
        this.modal.lastChunkCount = this.chunks;
    }

    async poll(): Promise<void> {
        await this.modal.checkIndexState();
        if (this.modal.lastQuery.trim() && this.modal.currentResults.length === 0) {
            this.modal.renderEmptyQuery(this.modal.loadKind);
        }
    }
}
