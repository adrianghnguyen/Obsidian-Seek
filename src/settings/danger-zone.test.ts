import { describe, expect, it } from 'vitest';
import {
    DANGER_ZONE_HEADING,
    consumerForceResetAvoidsFullReindex,
    dangerZoneActionRefreshesStatus,
    dangerZoneRows,
    dangerZoneSectionRows,
} from './danger-zone';

describe('Danger Zone settings catalog', () => {
    it('names the Danger Zone heading', () => {
        expect(DANGER_ZONE_HEADING).toBe('Danger Zone');
    });

    it('keeps full delete, recover, force-reset, and settings reset on the Settings tab', () => {
        const ids = dangerZoneRows({ mayFullReindex: true }).map(r => r.id);
        expect(ids).toEqual(['full-reindex', 'recover', 'force-reset', 'reset-settings']);
        expect(dangerZoneRows({ mayFullReindex: true }).every(r => r.alwaysVisible)).toBe(true);
    });

    it('places self-heal recover and force-reset in Danger Zone, not command-palette-only', () => {
        const zone = dangerZoneSectionRows({ mayFullReindex: true });
        expect(zone.map(r => r.id)).toEqual(['recover', 'force-reset', 'reset-settings']);
        expect(zone.find(r => r.id === 'recover')?.pluginMethod).toBe('recoverIndexFromSettings');
        expect(zone.find(r => r.id === 'force-reset')?.pluginMethod).toBe('forceResetIndexFromSettings');
    });

    it('does not invent a second recovery path — force reset is the existing self-heal', () => {
        const reset = dangerZoneRows({ mayFullReindex: true }).find(r => r.id === 'force-reset');
        expect(reset?.pluginMethod).toBe('forceResetIndexFromSettings');
        expect(reset?.pluginMethod).not.toBe('runFullReindex');
    });

    it('keeps a Consumer force-reset off runFullReindex', () => {
        const rows = dangerZoneRows({ mayFullReindex: false });
        const reset = rows.find(r => r.id === 'force-reset')!;
        expect(reset.pluginMethod).toBe('forceResetIndexFromSettings');
        expect(consumerForceResetAvoidsFullReindex(reset, false)).toBe(true);
        expect(reset.desc).not.toMatch(/re-embeds every/i);
        expect(reset.desc).toMatch(/does not re-embed/i);
        expect(reset.desc).toContain('lead computer');
        const recover = rows.find(r => r.id === 'recover')!;
        expect(recover.pluginMethod).toBe('recoverIndexFromSettings');
        expect(recover.desc).toContain('Does not start a full reindex');
    });

    it('requires confirm + warning on force reset', () => {
        const reset = dangerZoneRows({ mayFullReindex: true }).find(r => r.id === 'force-reset')!;
        expect(reset.needsConfirm).toBe(true);
        expect(reset.warningButton).toBe(true);
        expect(reset.destructive).toBe(true);
    });

    it('marks recover and force-reset as status-refreshing clicks', () => {
        expect(dangerZoneActionRefreshesStatus('recoverIndexFromSettings')).toBe(true);
        expect(dangerZoneActionRefreshesStatus('forceResetIndexFromSettings')).toBe(true);
        expect(dangerZoneActionRefreshesStatus('resetSettings')).toBe(false);
        expect(dangerZoneActionRefreshesStatus('runFullReindex')).toBe(false);
    });
});
