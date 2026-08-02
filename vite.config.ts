/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;
const macosE2eFrontend = process.env.VELLORA_MACOS_E2E === '1'
  ? {
      name: 'vellora-macos-e2e-frontend',
      transformIndexHtml: {
        order: 'pre' as const,
        handler() {
          return [
            {
              tag: 'script',
              attrs: { type: 'module', src: '/mac/e2e-frontend.js' },
              injectTo: 'body-prepend' as const
            }
          ];
        }
      }
    }
  : undefined;

export default defineConfig({
  plugins: [react(), macosE2eFrontend],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/e2e/**/*.test.mjs']
  }
});
