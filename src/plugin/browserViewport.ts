import type { BrowserCommand } from 'vitest/node';
import type { FullPageSize } from '../runtime/fullPage.js';

/** The name the runtime calls the command by (`commands.qlipBrowserViewport`). */
export const QLIP_BROWSER_VIEWPORT_COMMAND = 'qlipBrowserViewport';

/** The slice of a Playwright `Page` the command touches; qlip has no playwright dependency. */
interface PlaywrightPageLike {
  viewportSize(): FullPageSize | null;
  setViewportSize(size: FullPageSize): Promise<void>;
}

/**
 * Reads — and, given a size, sets — the browser window's viewport: the
 * Playwright context viewport that Vitest scales the test iframe to fit into.
 * A capture whose viewport is taller or wider than the window comes back
 * shrunk to fit unless the window grows with it (a 844px phone story in a
 * 720px window is an 85% picture of it; a 3,600px full-page capture in a
 * 1,440px window, a 40% one). Runs in the Vitest server process where the
 * Playwright page lives; the runtime reaches it through
 * `commands.qlipBrowserViewport`.
 *
 * Answers the size the window had before the call, or `null` when there is
 * no such viewport to grow: another provider (webdriverio resizes the real
 * window from `page.viewport()` and scales nothing), or a context launched
 * with `viewport: null`.
 */
export const qlipBrowserViewport: BrowserCommand<[size?: FullPageSize | null]> = async (
  context,
  size,
) => {
  const page = (context as { page?: PlaywrightPageLike }).page;
  if (context.provider.name !== 'playwright' || !page) {
    return null;
  }
  const current = page.viewportSize();
  if (size && current && (size.width !== current.width || size.height !== current.height)) {
    await page.setViewportSize(size);
  }
  return current;
};
