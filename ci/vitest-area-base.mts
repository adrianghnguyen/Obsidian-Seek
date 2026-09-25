import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export function areaConfig(include: string[]) {
    return mergeConfig(
        base,
        defineConfig({
            test: {
                include,
            },
        }),
    );
}
