/**
 * Settings → Index → Danger Zone catalog.
 *
 * Buttons call existing SeekPlugin recovery methods — do not add a second
 * wipe/rebuild path here. Consumer (`mayFullReindex: false`) must never wire
 * Force reset to `runFullReindex`.
 */

export const DANGER_ZONE_HEADING = 'Danger Zone';

export type DangerZoneActionId = 'full-reindex' | 'recover' | 'force-reset' | 'reset-settings';

export type DangerZonePluginMethod =
    | 'runFullReindex'
    | 'recoverIndexFromSettings'
    | 'forceResetIndexFromSettings'
    | 'resetSettings';

export interface DangerZoneRow {
    id: DangerZoneActionId;
    name: string;
    desc: string;
    pluginMethod: DangerZonePluginMethod;
    /** Where the control is painted. */
    section: 'index-primary' | 'danger-zone';
    destructive: boolean;
    needsConfirm: boolean;
    /** Always on the Settings tab — not only when health is stuck/locked. */
    alwaysVisible: boolean;
    buttonLabel: string;
    warningButton: boolean;
}

export function dangerZoneRows(input: { mayFullReindex: boolean }): DangerZoneRow[] {
    const consumer = !input.mayFullReindex;
    return [
        {
            id: 'full-reindex',
            name: 'Full reindex',
            desc: consumer
                ? 'Full reindex stays on the lead computer. This device will not re-embed the vault.'
                : 'Stops any current indexing, clears the index hold, and rebuilds from scratch — all inside Seek.',
            pluginMethod: 'runFullReindex',
            section: 'index-primary',
            destructive: true,
            needsConfirm: true,
            alwaysVisible: true,
            buttonLabel: 'Reindex…',
            warningButton: true,
        },
        {
            id: 'recover',
            name: 'Recover search index',
            desc: consumer
                ? 'Retry opening the index and resume restore from the lead computer’s files. Does not start a full reindex.'
                : 'Retry opening the index and resume leftover coverage. Same self-heal as Recover → Resume indexing / Retry.',
            pluginMethod: 'recoverIndexFromSettings',
            section: 'danger-zone',
            destructive: false,
            needsConfirm: false,
            alwaysVisible: true,
            buttonLabel: 'Resume indexing',
            warningButton: false,
        },
        {
            id: 'force-reset',
            name: 'Force reset search index',
            desc: consumer
                ? 'Deletes this device’s local search database and restores it from the lead computer’s index files. Does not re-embed the vault.'
                : 'Deletes the local search database and restores it (self-heal). Search is unavailable until restore finishes.',
            pluginMethod: 'forceResetIndexFromSettings',
            section: 'danger-zone',
            destructive: true,
            needsConfirm: true,
            alwaysVisible: true,
            buttonLabel: 'Force reset…',
            warningButton: true,
        },
        {
            id: 'reset-settings',
            name: 'Reset to defaults',
            desc: 'Restore all Seek settings to their original values. Your index will not be rebuilt.',
            pluginMethod: 'resetSettings',
            section: 'danger-zone',
            destructive: true,
            needsConfirm: true,
            alwaysVisible: true,
            buttonLabel: 'Reset…',
            warningButton: false,
        },
    ];
}

export function dangerZoneSectionRows(input: { mayFullReindex: boolean }): DangerZoneRow[] {
    return dangerZoneRows(input).filter(row => row.section === 'danger-zone');
}

/** Force reset / recover must refresh IndexStatusReporter — never a silent no-op. */
export function dangerZoneActionRefreshesStatus(method: DangerZonePluginMethod): boolean {
    return method === 'recoverIndexFromSettings' || method === 'forceResetIndexFromSettings';
}

export function consumerForceResetAvoidsFullReindex(row: DangerZoneRow, mayFullReindex: boolean): boolean {
    if (row.id !== 'force-reset') return true;
    if (mayFullReindex) return true;
    return row.pluginMethod === 'forceResetIndexFromSettings';
}
