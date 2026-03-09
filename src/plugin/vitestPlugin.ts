import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';
import pkg from '../../package.json' with { type: 'json' };
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_VIEWPORT,
  TOOL_NAME,
  generateBuildId,
} from '../fs/output.js';
import { QlipPluginOptions, QlipRuntimeConfig } from '../types.js';

const normalizePath = (value: string) => value.replace(/\\/g, '/');

export const qlipVitestPlugin = (
  options: QlipPluginOptions = {},
): Plugin => {
  const buildId = options.buildId ?? generateBuildId();
  let runtimeConfig: QlipRuntimeConfig | null = null;

  return {
    name: 'qlip-vitest-plugin',
    enforce: 'pre',
    config: (config) => {
      const root = config.root ?? process.cwd();
      const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
      const resolvedOutputDir = normalizePath(path.resolve(root, outputDir));
      const buildDir = normalizePath(path.join(resolvedOutputDir, buildId));
      const version = (pkg as { version?: string }).version ?? '0.0.0';

      runtimeConfig = {
        buildId,
        outputDir: resolvedOutputDir,
        buildDir,
        defaults: {
          outputDir,
          viewport: options.viewport ?? DEFAULT_VIEWPORT,
          skip: false,
          disableAnimations: options.disableAnimations ?? false,
          pauseAnimationsAtEnd: options.pauseAnimationsAtEnd ?? false,
          captureOnError: options.captureOnError ?? false,
          waitForIdleMs: options.waitForIdleMs ?? 300,
          maxWaitForIdleMs: options.maxWaitForIdleMs ?? 2000,
          ignoreElements: options.ignoreElements ?? [],
          auto: options.auto ?? true,
          manual: options.manual ?? true,
          error: options.error ?? true,
          captureConsole: options.captureConsole ?? true,
          captureConsoleLevels: options.captureConsoleLevels ?? ['error'],
          maxConsoleLogs: options.maxConsoleLogs ?? 50,
        },
        tool: { name: TOOL_NAME, version },
      };

      const setupTs = fileURLToPath(
        new URL('../runtime/setup.ts', import.meta.url),
      );
      const setupJs = fileURLToPath(
        new URL('../runtime/setup.js', import.meta.url),
      );
      const setupFile = existsSync(setupTs) ? setupTs : setupJs;
      const existingSetupFiles = config.test?.setupFiles;
      const setupFiles = new Set<string>();
      if (typeof existingSetupFiles === 'string') {
        setupFiles.add(existingSetupFiles);
      } else if (Array.isArray(existingSetupFiles)) {
        existingSetupFiles.forEach((file) => setupFiles.add(file));
      }
      setupFiles.add(setupFile);

      return {
        define: {
          __QLIP_CONFIG__: JSON.stringify(runtimeConfig),
        },
        test: {
          setupFiles: Array.from(setupFiles),
        },
      };
    },
    async configResolved() {
      if (!runtimeConfig) {
        return;
      }
      await fs.mkdir(runtimeConfig.buildDir, { recursive: true });
      await fs.mkdir(path.join(runtimeConfig.buildDir, 'stories'), {
        recursive: true,
      });
      await fs.mkdir(path.join(runtimeConfig.buildDir, 'logs'), {
        recursive: true,
      });
    },
  };
};
