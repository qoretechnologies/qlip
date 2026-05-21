import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { qlipVitestPlugin } from './src/index.js';
const dirname =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      reporter: ['text', 'json', 'html'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({
            configDir: path.join(dirname, '.storybook'),
          }),
          qlipVitestPlugin({
            outputDir: process.env.QLIP_OUTPUT_DIR,
            // Enable upload when QLIP_UPLOAD_URL is set in the env.
            // See design/UPLOAD.md.
            ...(process.env.QLIP_UPLOAD_URL
              ? {
                  upload: {
                    serverUrl: process.env.QLIP_UPLOAD_URL,
                    uploadToken: process.env.QLIP_UPLOAD_TOKEN,
                    project: process.env.QLIP_PROJECT ?? 'default',
                  },
                }
              : {}),
          }),
        ],
        optimizeDeps: {
          include: [
            'react',
            'react-dom',
            'react/jsx-dev-runtime',
            '@storybook/react-vite',
            '@storybook/addon-vitest',
          ],
        },
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [
              {
                browser: 'chromium',
              },
            ],
          },
          setupFiles: ['.storybook/vitest.setup.ts'],
        },
      },
    ],
  },
});
