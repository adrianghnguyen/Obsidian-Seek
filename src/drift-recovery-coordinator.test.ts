import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftRecoveryCoordinator, type DriftRecoveryDeps, type DriftIndexHealth } from './drift-recovery-coordinator';
import type { SearchOrchestrator } from './search';

describe('DriftRecoveryCoordinator', () => {
    let mockOrchestrator: {
        currentGeneration: ReturnType<typeof vi.fn>;
        hydrateSidecar: ReturnType<typeof vi.fn>;
        warmCaches: ReturnType<typeof vi.fn>;
        verifyCoherent: ReturnType<typeof vi.fn>;
    };
    let health: DriftIndexHealth;
    let degradedReason: 'version' | 'drift' | null;
    let indexingBlocked: boolean;
    let isHidden: boolean;
    let deps: DriftRecoveryDeps;
    let coordinator: DriftRecoveryCoordinator;

    beforeEach(() => {
        mockOrchestrator = {
            currentGeneration: vi.fn().mockReturnValue(1),
            hydrateSidecar: vi.fn().mockResolvedValue(null),
            warmCaches: vi.fn().mockResolvedValue(undefined),
            verifyCoherent: vi.fn().mockResolvedValue(true),
        };
        health = 'healthy';
        degradedReason = null;
        indexingBlocked = false;
        isHidden = false;

        deps = {
            getOrchestrator: () => mockOrchestrator as unknown as SearchOrchestrator,
            getIndexHealth: () => health,
            setIndexHealth: (h) => { health = h; },
            setDegradedReason: (r) => { degradedReason = r; },
            isIndexingBlocked: () => indexingBlocked,
            isSessionWorkCurrent: () => true,
            getLoadGeneration: () => 1,
            appendErrorIfCurrent: vi.fn(),
            withSidecarHydrate: (fn) => fn(),
            isDocumentHidden: () => isHidden,
        };

        coordinator = new DriftRecoveryCoordinator(deps);
    });

    it('initializes with default values', () => {
        expect(coordinator.running).toBe(false);
        expect(coordinator.pending).toBe(false);
        expect(coordinator.lastRecoveryGen).toBe(-1);
    });

    it('triggers recovery on persistent drift and recovers to healthy', async () => {
        coordinator.onPersistentDrift();
        expect(coordinator.lastRecoveryGen).toBe(1);

        // Wait for async recovery ladder to resolve
        await vi.waitFor(() => expect(coordinator.running).toBe(false));

        expect(mockOrchestrator.hydrateSidecar).toHaveBeenCalled();
        expect(mockOrchestrator.warmCaches).toHaveBeenCalledWith('drift-recovery');
        expect(mockOrchestrator.verifyCoherent).toHaveBeenCalled();
        expect(health).toBe('healthy');
        expect(degradedReason).toBeNull();
    });

    it('marks index degraded if verifyCoherent fails', async () => {
        mockOrchestrator.verifyCoherent.mockResolvedValue(false);

        coordinator.onPersistentDrift();
        await vi.waitFor(() => expect(coordinator.running).toBe(false));

        expect(health).toBe('degraded');
        expect(degradedReason).toBe('drift');
    });

    it('suppresses re-escalation on persistent drift at the same generation', async () => {
        coordinator.onPersistentDrift();
        await vi.waitFor(() => expect(coordinator.running).toBe(false));
        expect(mockOrchestrator.hydrateSidecar).toHaveBeenCalledTimes(1);

        // Call again at the same generation (gen = 1)
        coordinator.onPersistentDrift();
        expect(coordinator.pending).toBe(false);
        expect(mockOrchestrator.hydrateSidecar).toHaveBeenCalledTimes(1);
    });

    it('defers recovery when indexing is blocked', () => {
        indexingBlocked = true;
        coordinator.onPersistentDrift();

        expect(coordinator.pending).toBe(true);
        expect(coordinator.running).toBe(false);
        expect(mockOrchestrator.hydrateSidecar).not.toHaveBeenCalled();
    });

    it('handles exception in recovery ladder and sets health to degraded', async () => {
        mockOrchestrator.hydrateSidecar.mockRejectedValue(new Error('Hydrate failed'));

        coordinator.onPersistentDrift();
        await vi.waitFor(() => expect(coordinator.running).toBe(false));

        expect(health).toBe('degraded');
        expect(degradedReason).toBe('drift');
        expect(deps.appendErrorIfCurrent).toHaveBeenCalled();
    });
});
