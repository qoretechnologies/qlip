import { afterEach, beforeEach } from 'vitest';
import { captureAutoScreenshot, captureErrorScreenshot } from './screenshot.js';
import { flushConsoleLogs, getRuntimeState, initRuntimeState, pushConsoleLog } from './context.js';
import type { QlipConsoleLevel } from '../types.js';
import { realDateNow } from './clock.js';

const isBrowser = () => typeof globalThis.__vitest_browser__ !== 'undefined';

export const VIEWPORT_RESET_STYLE_ID = '__qlip-viewport-reset';

// Storybook's portable stories mount every story into an anonymous <div>
// (no id, no class) appended to <body>; it needs the full viewport for
// height-filling stories. A bare `body > div` also matched everything React
// portals into <body> (reqore's fixed-position floating-actions bar, popovers)
// and stretched it to 100% x 100%, which captured as opaque black rectangles.
// `:first-of-type` is no alternative: Storybook's hidden `sb-wrapper` divs
// precede the canvas.
export const VIEWPORT_RESET_CSS =
  'html, body, #storybook-root, body > div:not([class]):not([id]) { width: 100%; height: 100%; margin: 0; padding: 0; }';

/** Exported for unit testing. */
export const injectViewportStyles = () => {
  const doc = globalThis.document;
  if (!doc) return;
  const style = doc.createElement('style');
  style.id = VIEWPORT_RESET_STYLE_ID;
  style.textContent = VIEWPORT_RESET_CSS;
  doc.head.appendChild(style);
};

const serializeArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
};

const installConsoleInterceptors = () => {
  const state = getRuntimeState();
  if (!state) return;

  const globalAny = globalThis as { __QLIP_CONSOLE_INSTALLED__?: boolean };
  if (globalAny.__QLIP_CONSOLE_INSTALLED__) return;
  globalAny.__QLIP_CONSOLE_INSTALLED__ = true;

  const levels = state.config.defaults.captureConsoleLevels;
  const maxLogs = state.config.defaults.maxConsoleLogs;
  const excludePatterns = state.config.defaults.consoleLogExcludePatterns
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter((re): re is RegExp => re !== null);

  for (const level of levels) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      original.apply(console, args);

      const currentState = getRuntimeState();
      if (!currentState) return;

      const message = args.map(serializeArg).join(' ');
      if (message.startsWith('[qlip]')) return;
      if (excludePatterns.some((re) => re.test(message))) return;

      pushConsoleLog(
        currentState,
        { level: level as QlipConsoleLevel, message, timestamp: realDateNow() },
        maxLogs,
      );
    };
  }
};

if (isBrowser()) {
  initRuntimeState();
  installConsoleInterceptors();
  injectViewportStyles();
  beforeEach(() => {
    const state = getRuntimeState();
    if (state) {
      flushConsoleLogs(state);
    }
  });
  afterEach(async (context) => {
    await captureAutoScreenshot(context);
    const runtime = getRuntimeState();
    if (
      runtime &&
      context.task.result?.state === 'fail'
    ) {
      await captureErrorScreenshot(context);
    }
  });
}
