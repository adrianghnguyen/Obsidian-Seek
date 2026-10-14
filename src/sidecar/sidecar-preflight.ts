/**
 * Hydrate preflight: refuse to start until accepted producers' jsonl offsets
 * resolve to local shard files with a real payload (not 0-byte / dataless).
 * CRC-corrupt records are counted and skipped later by hydrate — never a
 * reason to wipe the peer device.
 */

import type { DataAdapter } from 'obsidian';
import {
    decodeRecord,
    deviceIdFromJsonlPath,
    isOffsetInRange,
    listDeviceJsonls,
    liveRecordBytes,
    scanJsonl,
    shardPathFor,
} from './sidecar';
import { metaAccepts, readDeviceMeta, type MetaExpectation } from './sidecar-meta';

export interface SidecarPreflight {
    /** At least one matching producer whose referenced shards are fully local. */
    ready: boolean;
    matchingProducers: number;
    incomplete: boolean;
    datalessShards: number;
    missingShards: number;
    shortShards: number;
    crcFailures: number;
    staleProducers: number;
}

const EMPTY: SidecarPreflight = {
    ready: false,
    matchingProducers: 0,
    incomplete: false,
    datalessShards: 0,
    missingShards: 0,
    shortShards: 0,
    crcFailures: 0,
    staleProducers: 0,
};

export async function preflightSidecar(
    adapter: DataAdapter,
    indexDir: string,
    expect: MetaExpectation,
    selfDeviceId?: string,
): Promise<SidecarPreflight> {
    const jsonls = await listDeviceJsonls(adapter, indexDir);
    if (jsonls.length === 0) return { ...EMPTY };

    const accepted: string[] = [];
    let staleProducers = 0;
    for (const jsonl of jsonls) {
        const dev = deviceIdFromJsonlPath(jsonl);
        if (!dev) continue;
        const meta = await readDeviceMeta(adapter, indexDir, dev);
        if (metaAccepts(meta, expect)) accepted.push(jsonl);
        else if (selfDeviceId && dev === selfDeviceId) continue;
        else staleProducers++;
    }
    if (accepted.length === 0) {
        return { ...EMPTY, staleProducers };
    }

    const scan = await scanJsonl(adapter, accepted);
    const stride = liveRecordBytes();
    const shardNeed = new Map<string, number>(); // path → min size required
    for (const e of scan.map.values()) {
        const path = shardPathFor(indexDir, e.shard, e.seq);
        const need = e.off + stride;
        const prev = shardNeed.get(path) ?? 0;
        if (need > prev) shardNeed.set(path, need);
    }

    let datalessShards = 0;
    let missingShards = 0;
    let shortShards = 0;
    let crcFailures = 0;
    const bufCache = new Map<string, ArrayBuffer | null>();

    for (const [path, need] of shardNeed) {
        const st = typeof adapter.stat === 'function'
            ? await adapter.stat(path).catch(() => null)
            : null;
        if (!st || st.size == null) {
            missingShards++;
            continue;
        }
        if (st.size === 0) {
            datalessShards++;
            continue;
        }
        if (st.size < need || !isOffsetInRange(st.size, need - stride)) {
            shortShards++;
            continue;
        }
        let buf = bufCache.get(path);
        if (buf === undefined) {
            buf = await adapter.readBinary(path).catch(() => null);
            bufCache.set(path, buf);
        }
    }

    for (const e of scan.map.values()) {
        const path = shardPathFor(indexDir, e.shard, e.seq);
        const buf = bufCache.get(path);
        if (!buf) continue;
        if (!isOffsetInRange(buf.byteLength, e.off)) continue;
        try {
            decodeRecord(buf, e.off, e.dim);
        } catch {
            crcFailures++;
        }
    }

    const incomplete = datalessShards > 0 || missingShards > 0 || shortShards > 0;
    return {
        ready: !incomplete,
        matchingProducers: accepted.length,
        incomplete,
        datalessShards,
        missingShards,
        shortShards,
        crcFailures,
        staleProducers,
    };
}
