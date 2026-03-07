import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 8765,
    headers: {
      // Required for DuckDB WASM SharedArrayBuffer / web workers
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 8765,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['../tests/unit/**/*.test.js'],
    setupFiles: ['../tests/unit/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../coverage',
      thresholds: {
        'src/App/App.js': {
          statements: 80,
          branches: 50,
          functions: 80,
          lines: 80,
        },
        'src/QueryUi/QueryUi.js': {
          statements: 60,
          branches: 70,
          functions: 70,
          lines: 60,
        },
        'src/PivotTableUi/PivotTableUi.js': {
          statements: 45,
          branches: 35,
          functions: 70,
          lines: 45,
        },
        'src/PostMessageInterface/PostMessageInterface.js': {
          statements: 68,
          branches: 60,
          functions: 70,
          lines: 68,
        },
        'src/DataSet/CellSet.js': {
          statements: 58,
          branches: 75,
          functions: 80,
          lines: 58,
        },
        'src/QueryModel/QuerySerializer.js': {
          statements: 85,
          lines: 85,
        },
        'src/QueryModel/QueryModelConstants.js': {
          statements: 100,
          lines: 100,
        },
        'src/AttributeUi/AttributeRegistry.js': {
          statements: 80,
          lines: 80,
        },
      },
    },
  },
});
