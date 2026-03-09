import { afterEach, beforeEach } from 'vitest';
import { captureAutoScreenshot, captureErrorScreenshot } from './screenshot.js';
import { flushConsoleLogs, getRuntimeState, initRuntimeState, pushConsoleLog } from './context.js';
import type { QlipConsoleLevel } from '../types.js';

const isBrowser = () => typeof globalThis.__vitest_browser__ !== 'undefined';

const injectViewportStyles = () => {
  const doc = globalThis.document;
  if (!doc) return;
  const style = doc.createElement('style');
  style.id = '__qlip-viewport-reset';
  style.textContent = `html, body, body > div, #storybook-root { width: 100%; height: 100%; margin: 0; padding: 0; }`;
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

  for (const level of levels) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      original.apply(console, args);

      const currentState = getRuntimeState();
      if (!currentState) return;

      const message = args.map(serializeArg).join(' ');
      if (message.startsWith('[qlip]')) return;

      pushConsoleLog(
        currentState,
        { level: level as QlipConsoleLevel, message, timestamp: Date.now() },
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
