/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Runs the golden generator against the frozen baseline sources without adding
// files to the legacy application or changing its own test discovery.
export default defineConfig({
  root: new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  test: {
    environment: 'jsdom',
    include: ['native/tools/goldens/*.gen.ts']
  }
});
