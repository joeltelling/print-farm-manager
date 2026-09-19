import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Pin the timezone before any test worker starts, so date formatting assertions do not
// depend on the machine (or CI runner) the suite happens to run on.
process.env.TZ = 'UTC';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    // Layer 1 tests are pure logic and need no DOM. A test that does need one opts in with a
    // `// @vitest-environment happy-dom` header (added in a later phase).
    environment: 'node',
  },
}));
