import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The `obsidian` package is types-only (package.json main: "") — esbuild
// externalizes it at build time, but vitest needs a resolvable runtime module
// for the handful of files that import a runtime VALUE from it (currently just
// platform.ts → Platform). Alias it to a tiny test stub. Inert for the rest of
// the suite, which imports nothing from obsidian.
// Benchmarks seed large in-memory corpora (fake-indexeddb + 5k-chunk BM25 fits),
// which OOMs the default `threads` pool — worker_threads ignore
// --max-old-space-size. Run bench in a `forks` child process (which DOES honor
// the heap flag via execArgv) with a raised heap. Gated on the bench env vars so
// the normal test suite keeps the faster threads pool. vitest applies `test.pool`
// to benchmark runs too (there is no separate `benchmark.pool`).
const isBench = !!process.env.SEEK_BENCH_SIZE || process.env.SEEK_BENCH_FULL === '1';

export default defineConfig({
    // Provide `window`/`activeWindow` in the Node env so the plugin's
    // popout-window-safe `window.setTimeout`/`activeWindow` calls resolve under
    // test (see test-stubs/test-setup.ts). Patchable by vi.useFakeTimers().
    test: {
        setupFiles: [fileURLToPath(new URL('./src/test-stubs/test-setup.mts', import.meta.url))],
        ...(isBench
            ? {
                pool: 'forks' as const,
                poolOptions: {
                    forks: {
                        singleFork: true,
                        execArgv: ['--max-old-space-size=8192'],
                    },
                },
            }
            : {}),
    },
    benchmark: {
        include: ['src/**/*.bench.ts'],
        setupFiles: [fileURLToPath(new URL('./src/test-stubs/test-setup.mts', import.meta.url))],
    },
    resolve: {
        alias: {
            obsidian: fileURLToPath(new URL('./src/test-stubs/obsidian.ts', import.meta.url)),
        },
    },
});
