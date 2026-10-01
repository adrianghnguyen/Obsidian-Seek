/**
 * @file confirm-modal.ts
 * @module ConfirmModal
 *
 * ## Responsibilities
 * Mobile-safe asynchronous confirmation dialog:
 * - Replaces native browser `window.confirm()`, which is suppressed or blocks the main UI
 *   thread in mobile WebViews (iOS/iPadOS and Android).
 * - Renders a modal prompt with formatted multiline text and explicit "Proceed" / "Cancel" buttons.
 * - Resolves a Promise with `true` on explicit proceed, or `false` on cancel / click-outside / Esc.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: UI / Presentation Layer.
 * - **Lifecycle**: Ephemeral dialog. Instantiated on-demand by `SeekPlugin.runFullReindex()`
 *   before initiating destructive index resets, and closes immediately upon user choice.
 */

import { App, Modal } from 'obsidian';

// Minimal confirm dialog. Replaces the native window.confirm(), which is
// unreliable on mobile (the WebView can suppress it). Resolves true when the
// user confirms, false on Cancel or any dismissal (Esc / click-outside).
export class ConfirmModal extends Modal {
    private settled = false;
    private resolve: ((value: boolean) => void) | null = null;

    constructor(app: App, private readonly message: string) {
        super(app);
    }

    openAndConfirm(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        for (const line of this.message.split('\n')) {
            this.contentEl.createEl('p', { text: line });
        }
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        const proceed = buttons.createEl('button', { text: 'Proceed', cls: 'mod-cta' });
        proceed.addEventListener('click', () => this.settle(true));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.settle(false));
    }

    onClose(): void {
        // Dismissed without a button (Esc / click-outside) → treat as Cancel.
        this.settle(false);
    }

    private settle(value: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve?.(value);
        this.close();
    }
}
