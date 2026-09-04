import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { ConfirmModal } from './confirm-modal';

describe('ConfirmModal', () => {
    it('constructs and handles user rejection via onClose', async () => {
        const app = new App();
        const modal = new ConfirmModal(app, 'Are you sure you want to reindex?');
        expect(modal).toBeDefined();

        const confirmPromise = modal.openAndConfirm();
        modal.onClose();

        const result = await confirmPromise;
        expect(result).toBe(false);
    });

    it('handles DOM creation on onOpen and button click', async () => {
        const app = new App();
        const modal = new ConfirmModal(app, 'Line 1\nLine 2');

        // Mock contentEl with createEl / createDiv
        const clickHandlers: Record<string, () => void> = {};
        const mockEl = {
            createEl: vi.fn((tag: string, opts?: { text?: string; cls?: string }) => {
                const btn = {
                    addEventListener: (event: string, handler: () => void) => {
                        if (opts?.text) clickHandlers[opts.text] = handler;
                    },
                };
                return btn;
            }),
            createDiv: vi.fn(() => ({
                createEl: (tag: string, opts?: { text?: string; cls?: string }) => {
                    const btn = {
                        addEventListener: (event: string, handler: () => void) => {
                            if (opts?.text) clickHandlers[opts.text] = handler;
                        },
                    };
                    return btn;
                },
            })),
        };
        (modal as unknown as { contentEl: typeof mockEl }).contentEl = mockEl;

        const confirmPromise = modal.openAndConfirm();
        modal.onOpen();

        expect(mockEl.createEl).toHaveBeenCalledWith('p', { text: 'Line 1' });
        expect(mockEl.createEl).toHaveBeenCalledWith('p', { text: 'Line 2' });

        // Trigger proceed button click
        expect(clickHandlers['Proceed']).toBeDefined();
        clickHandlers['Proceed']();

        const result = await confirmPromise;
        expect(result).toBe(true);
    });
});
