import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Pin the timezone before any test worker starts, so date formatting assertions do not
// depend on the machine (or CI runner) the suite happens to run on.
process.env.TZ = 'UTC';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    // Most tests are pure logic and run in plain Node. A test that needs a DOM (component,
    // hook, and page tests) opts in with a `// @vitest-environment happy-dom` header on its
    // first line.
    environment: 'node',
  },
}));
