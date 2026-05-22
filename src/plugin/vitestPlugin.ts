import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';
import type { VitestPluginContext } from 'vitest/node';
import pkg from '../../package.json' with { type: 'json' };
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_VIEWPORT,
  MANIFEST_FRAGMENT_DIR,
  TOOL_NAME,
  generateBuildId,
} from '../fs/output.js';
import { QlipPluginOptions, QlipRuntimeConfig } from '../types.js';
import { QlipUploadReporter } from '../upload/reporter.js';

const normalizePath = (value: string) => value.replace(/\\/g, '/');

export const qlipVitestPlugin = (
  options: QlipPluginOptions = {},
): Plugin => {
  const buildId = options.buildId ?? generateBuildId();
  let runtimeConfig: QlipRuntimeConfig | null = null;
  // Plugin instance state — `configureVitest` may fire once per project
  // (vitest's storybook + unit projects both load us); only register
  // the reporter the first time.
  let reporterRegistered = false;

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
          consoleLogExcludePatterns: options.consoleLogExcludePatterns ?? [],
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

      // Wire the upload reporter into Vitest when upload is configured.
      // We add ourselves alongside the user's reporters rather than
      // replacing them. When no reporter is set, Vitest's default is
      // implicit — re-add 'default' so we don't accidentally silence it.
      const baseReporters = config.test?.reporters;
      const reportersList = baseReporters
        ? Array.isArray(baseReporters)
          ? [...baseReporters]
          : [baseReporters]
        : ['default'];

      return {
        // Vitest browser mode's `commands.writeFile` enforces vite's
        // `server.fs.allow` allowlist before writing. When the output
        // dir lives outside the project root (e.g. a test tmpdir, or
        // a CI artifact path), the write is denied with "Access
        // denied". Add the output dir to the allowlist so per-context
        // manifest fragments + (incidentally) per-story PNGs can be
        // written from inside the browser.
        server: {
          fs: {
            allow: [resolvedOutputDir],
          },
        },
        define: {
          __QLIP_CONFIG__: JSON.stringify(runtimeConfig),
        },
        test: {
          setupFiles: Array.from(setupFiles),
          // NOTE: reporters are intentionally NOT set here. Project-level
          // `test.reporters` arrays don't receive the global lifecycle
          // events (onTestRunEnd etc.). The upload reporter is pushed
          // onto the global `vitest.reporters` array via the
          // `configureVitest` plugin hook below.
          reporters: reportersList,
        },
      };
    },
    /**
     * Vitest-specific plugin hook (NOT a Vite hook). Runs after Vitest
     * has resolved its config and created the Vitest instance — at
     * which point we can push our reporter onto the live global
     * reporters array, where lifecycle events (onTestRunEnd) actually
     * fire.
     *
     * The plugin instance is shared across projects in a Vitest run,
     * so configureVitest can fire multiple times (once per project
     * that loads us). `reporterRegistered` deduplicates.
     *
     * The reporter is registered **unconditionally** — it always
     * merges per-browser-context manifest fragments into the canonical
     * `manifest.json` (see `src/upload/manifest.ts`). The upload step
     * inside the reporter no-ops when `options.upload` is absent, so
     * local-only users still get their `manifest.json` written.
     */
    configureVitest(context: VitestPluginContext) {
      if (reporterRegistered) return;
      if (!runtimeConfig) return;

      // Push onto `vitest.config.reporters` — NOT `vitest.reporters`.
      // The runtime `vitest.reporters` array is built immediately
      // after configureVitest by `createReporters(resolved.reporters,
      // this)` (vitest's cli-api.js line ~12251), which replaces any
      // direct mutation of the runtime array. The config array is
      // what gets fed into that, so pushing here makes our reporter
      // a first-class member of the resolved reporter set.
      const cfg = context.vitest.config as unknown as {
        reporters: unknown[];
      };
      cfg.reporters.push(
        new QlipUploadReporter({
          runtime: runtimeConfig,
          ...(options.upload !== undefined
            ? { upload: options.upload }
            : {}),
        }),
      );
      reporterRegistered = true;
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
      // Fragments dir must exist before any browser context tries to
      // write into it — the browser-side `commands.writeFile` doesn't
      // do `mkdir -p`.
      await fs.mkdir(path.join(runtimeConfig.buildDir, MANIFEST_FRAGMENT_DIR), {
        recursive: true,
      });
    },
  };
};
