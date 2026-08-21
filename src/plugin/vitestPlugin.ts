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
import { stashFinalizeConfig } from '../runtime/global-setup.js';

const normalizePath = (value: string) => value.replace(/\\/g, '/');

export const qlipVitestPlugin = (options: QlipPluginOptions = {}): Plugin => {
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
          // On by default — a black-box `backdrop-filter` artifact is
          // never a wanted baseline. See QlipCaptureOptions.
          disableBackdropFilter: options.disableBackdropFilter ?? true,
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
        // Read here, in Node, because the browser runtime has no env.
        diagnostics: options.diagnostics ?? process.env['QLIP_DEBUG'] === '1',
      };

      const setupTs = fileURLToPath(
        new URL('../runtime/setup.ts', import.meta.url),
      );
      const setupJs = fileURLToPath(
        new URL('../runtime/setup.js', import.meta.url),
      );
      const setupFile = existsSync(setupTs) ? setupTs : setupJs;
      // Return ONLY our own entry — never copy the consumer's existing
      // `setupFiles` in here. Vite merges a `config` hook's return by
      // *concatenating* arrays onto the consumer config, so any entry we
      // echo back is added a second time. Echoing the consumer's setup
      // file is what wedged Storybook browser collection in qlip#17
      // (the setup ran twice, double-registering annotations/hooks).
      // Returning `[setupFile]` lets Vite append us exactly once,
      // leaving every consumer entry present exactly once. Same reasoning
      // for `globalSetup` and `reporters` below.

      // Wire the upload reporter into Vitest when upload is configured.
      // We add ourselves alongside the user's reporters rather than
      // replacing them. When no reporter is set, Vitest's default is
      // implicit — re-add 'default' so we don't accidentally silence it.
      const baseReporters = config.test?.reporters;
      // Vitest's `test.reporters` accepts a narrow union of string
      // names + `[name, options]` tuples + Reporter instances. Our
      // pushed `QlipUploadReporter` is duck-typed (it doesn't
      // `implements Reporter` so we can stay compat across V2/V4
      // interface drift). Casting through `Reporter[]` keeps the
      // returned config compatible with Vitest's expected shape.
      // Only our additions — Vite concatenates onto the consumer's
      // reporters, so copying `baseReporters` here would duplicate each
      // one (qlip#17). The one case we must handle: when the consumer set
      // no reporters, Vitest's implicit 'default' would be replaced by our
      // sole entry — so re-add 'default' in exactly that case to avoid
      // silencing console output. (Vite's merge arraifies a single
      // consumer reporter, so we never need to normalise it ourselves.)
      const reportersList = (
        baseReporters ? [] : ['default']
      ) as import('vitest/reporters').Reporter[];

      // 2026-05-23 — Vitest 2 compat. The `configureVitest` plugin
      // hook below was added in Vitest 3.1.0-beta.2 and is what we
      // rely on in Vitest 4 to push our reporter onto the *global*
      // reporters array (which gets reset by `createReporters` if
      // we push only in this `config` hook).
      //
      // On Vitest 2.x — used by qorus-ide and many Storybook 8.5
      // consumers — `configureVitest` doesn't exist and is silently
      // ignored. Without a fallback, the reporter never fires there:
      // captures land on disk, the manifest is never merged, the
      // upload never happens.
      //
      // The fix is to ALSO push a reporter instance directly here.
      // Verified by reading both Vitest 2.1 and 4.x dist:
      // `createReporters` returns pre-instantiated `Reporter`
      // instances as-is (V2.1 cli-api.js:5186, V4 cli-api.js:10611),
      // so this push survives in both. The reporter itself
      // implements both `onFinished` (V2 name) and `onTestRunEnd`
      // (V3+ name) and dedupes via an internal flag.
      //
      // On Vitest 4: this push survives → `onTestRunEnd` fires →
      // `finalize()` runs. The `configureVitest` push below is now
      // a no-op (dedup flag), kept only as a safety net for any
      // future Vitest variant that strips instances during
      // `createReporters`.
      //
      // On Vitest 2: this push is the only one → `onFinished` fires
      // → `finalize()` runs. `configureVitest` is never called.
      //
      // See `.tasks/VITEST_2_COMPAT.md` for the full investigation.
      const eagerReporter = new QlipUploadReporter({
        runtime: runtimeConfig,
        ...(options.upload !== undefined ? { upload: options.upload } : {}),
      });
      // Duck-typed cast: QlipUploadReporter doesn't `implements
      // Reporter` (so we can stay compat across V2/V4 interface
      // drift), but Vitest's runtime only looks for `onFinished` /
      // `onTestRunEnd` methods, both of which our class provides.
      reportersList.push(
        eagerReporter as unknown as import('vitest/reporters').Reporter,
      );

      // 2026-05-23 — Vitest 2 workspace-mode fallback. When the
      // plugin is mounted inside a workspace project (e.g.
      // qorus-ide's `vitest.workspace.ts`), the reporter push above
      // lands in the project's local config — but Vitest's
      // end-of-run lifecycle fires only on the **root** reporter
      // array (`this.reporters = await createReporters(resolved.reporters, ...)`
      // — V2.1 cli-api.js:10494). The project-local reporter is
      // never called.
      //
      // `globalSetup`, however, does fire per-project: each project
      // gets setup before its tests and teardown after. We append
      // our globalSetup file to `test.globalSetup`, which writes
      // `manifest.json` + uploads from teardown. The runtime config
      // is stashed on `globalThis` (same Node process) so the
      // globalSetup file can pick it up at teardown time without
      // re-reading config files.
      //
      // On V4 single-project: reporter fires first, finalize runs,
      // globalSetup teardown is a no-op (dedup flag). On V2
      // workspace: reporter is lifecycle-dead, globalSetup teardown
      // fires, finalize runs. Both paths converge on `finalizeBuild`.
      stashFinalizeConfig({
        runtime: runtimeConfig,
        ...(options.upload !== undefined ? { upload: options.upload } : {}),
      });
      const globalSetupTs = fileURLToPath(
        new URL('../runtime/global-setup.ts', import.meta.url),
      );
      const globalSetupJs = fileURLToPath(
        new URL('../runtime/global-setup.js', import.meta.url),
      );
      const globalSetupFile = existsSync(globalSetupTs)
        ? globalSetupTs
        : globalSetupJs;
      // Only our own entry — see the setupFiles note. Copying the
      // consumer's `globalSetup` here would double-run their setup.

      // Path to qlip's own package root, computed from this file's
      // URL. Used to add ourselves to vite's `server.fs.allow` so the
      // browser-mode runtime can fetch our `runtime/setup.js` even
      // when qlip is installed via `link:` (outside the consumer's
      // project root). Without this, link:-installed qlip fails at
      // startup with "Failed to fetch dynamically imported module:
      // .../qlip/dist/runtime/setup.js" — vite serves the URL with
      // a 403 because the absolute path is outside the allowlist.
      // npm-installed qlip lives under node_modules and is already
      // allowed by default; this is a no-op there.
      const qlipPackageRoot = fileURLToPath(new URL('../..', import.meta.url));

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
            allow: [resolvedOutputDir, qlipPackageRoot],
          },
        },
        define: {
          __QLIP_CONFIG__: JSON.stringify(runtimeConfig),
        },
        test: {
          setupFiles: [setupFile],
          globalSetup: [globalSetupFile],
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
          ...(options.upload !== undefined ? { upload: options.upload } : {}),
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
