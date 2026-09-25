import { CI_TEST_AREAS } from './test-areas.mts';
import { areaConfig } from './vitest-area-base.mts';

export default areaConfig([...CI_TEST_AREAS.search]);
