import { afterEach } from 'vitest';
import { captureAutoScreenshot, captureErrorScreenshot } from './screenshot.js';
import { getRuntimeState, initRuntimeState } from './context.js';

const isBrowser = () => typeof globalThis.__vitest_browser__ !== 'undefined';

const injectViewportStyles = () => {
  const doc = globalThis.document;
  if (!doc) return;
  const style = doc.createElement('style');
  style.id = '__qlip-viewport-reset';
  style.textContent = `html, body, body > div, #storybook-root { width: 100%; height: 100%; margin: 0; padding: 0; }`;
  doc.head.appendChild(style);
};

if (isBrowser()) {
  initRuntimeState();
  injectViewportStyles();
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
