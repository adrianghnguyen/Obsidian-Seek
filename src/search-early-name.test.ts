// Baseline + early-paint fixtures for the name-first search path.
// Uses the real orchestrator over a fake vault/embedder (Tier-2 Scenario).
import { describe, it, expect, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';
import type { SearchPartial, ScoredChunk } from './types';

describe('search early name paint', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    function writeFixture(s: Scenario, distractors: number): void {
        s.vault.write('Meetings/Alex 1x1 2026-05-19.md', 'standup notes with alex and the weekly 1x1', 1000);
        s.vault.write(
            'People/Alex Chen.md',
            '---\naliases:\n  - Alex C\n  - AC\n---\nmanager notes and 1x1 follow-ups\n',
            1000,
        );
        s.vault.write('Gadgets/Pixel.md', 'the verge reviews the new google pixel phone camera', 1000);
        for (let i = 0; i < distractors; i++) {
            s.vault.write(
                `Noise/n${i}.md`,
                `alex mentioned a 1x1 in passing and a pixel camera review ${i}`,
                1000 + i,
            );
        }
    }

    async function index(s: Scenario, distractors: number): Promise<void> {
        writeFixture(s, distractors);
        await s.coldStart();
    }

    it('fused rank-1 for filename and alias queries at 50 distractors (baseline)', async () => {
        const s = await boot();
        await index(s, 50);

        const filename = await s.orch.search('alex 1x1', 5, undefined, () => {});
        expect(filename.results[0]?.note_path).toBe('Meetings/Alex 1x1 2026-05-19.md');
        expect(filename.entry.nameEarlyPainted).toBe(true);
        expect(filename.entry.nameHitCount).toBeGreaterThan(0);

        const alias = await s.orch.search('alex che', 5, undefined, () => {});
        expect(alias.results[0]?.note_path).toBe('People/Alex Chen.md');
        expect(alias.entry.nameEarlyPainted).toBe(true);

        const exactAlias = await s.orch.search('ac', 5);
        expect(exactAlias.results.some(r => r.note_path === 'People/Alex Chen.md')).toBe(true);
    });

    it('topical query fires lexical partial, not name early-paint', async () => {
        const s = await boot();
        await index(s, 50);
        const partials: SearchPartial[] = [];
        const { results, entry } = await s.orch.search(
            'pixel camera review',
            5,
            undefined,
            p => { partials.push(p); },
        );
        // Lexical partial fires (new progressive behavior) but no NAME partial
        expect(partials.length).toBeGreaterThan(0);
        expect(partials[0].source).toBe('lexical');
        expect(entry.nameEarlyPainted).toBe(false);
        expect(results[0]?.note_path).toBe('Gadgets/Pixel.md');
    });

    it('onPartial fires with the alias gold before a delayed embed resolves', async () => {
        const s = await boot();
        await index(s, 50);

        const events: { t: number; kind: string; path?: string }[] = [];
        const t0 = performance.now();
        const orig = s.embedder.embed.bind(s.embedder);
        s.embedder.embed = async (text: string) => {
            events.push({ t: performance.now() - t0, kind: 'embed-start' });
            await new Promise(r => setTimeout(r, 40));
            const out = await orig(text);
            events.push({ t: performance.now() - t0, kind: 'embed-end' });
            return out;
        };

        let early: ScoredChunk[] = [];
        const { results, entry } = await s.orch.search('alex che', 5, undefined, p => {
            events.push({ t: performance.now() - t0, kind: 'partial', path: p.results[0]?.note_path });
            early = p.results;
        });

        const partial = events.find(e => e.kind === 'partial');
        const embedEnd = events.find(e => e.kind === 'embed-end');
        expect(partial).toBeDefined();
        expect(embedEnd).toBeDefined();
        expect(partial!.t).toBeLessThan(embedEnd!.t);
        expect(early[0]?.note_path).toBe('People/Alex Chen.md');
        expect(results[0]?.note_path).toBe('People/Alex Chen.md');
        expect(entry.namePartialMs).toBeGreaterThan(0);
        expect(entry.namePartialMs!).toBeLessThan(entry.queryEmbedMs);
        expect(entry.queryEmbedMs).toBeGreaterThanOrEqual(30);
    });

    it('name hits still surface at 200 body-distractor files', async () => {
        const s = await boot();
        await index(s, 200);
        const partials: string[] = [];
        const { results } = await s.orch.search('alex 1x1', 5, undefined, p => {
            partials.push(p.results[0]?.note_path ?? '');
        });
        expect(partials[0]).toBe('Meetings/Alex 1x1 2026-05-19.md');
        expect(results[0]?.note_path).toBe('Meetings/Alex 1x1 2026-05-19.md');
    });
});
