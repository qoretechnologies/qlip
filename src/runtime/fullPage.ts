/**
 * A `fullPage` capture grows the viewport until nothing on the page scrolls,
 * photographs it, and puts the viewport back. A story that pins a phone
 * viewport is otherwise one screen tall, and a browser "full page" screenshot
 * would not help: an app shell pins the document to the viewport and scrolls
 * an inner box, so the document is never taller than one screen.
 *
 * Under Vitest browser mode two viewports are involved. `page.viewport()`
 * sizes the test iframe; the real browser window (the Playwright context
 * viewport) stays as configured, and Vitest scales the iframe down to fit it.
 * A 3,600px-tall iframe in a 1,440px window is photographed at 40% — the
 * whole page, unreadable — and so is a plain 844px-tall phone story in a
 * 720px window, at 85%. `createCaptureViewport` therefore grows the window
 * to hold whatever viewport a capture asks for, pinned or grown, and puts
 * both back afterwards, the window first, so the iframe lands at scale 1.
 *
 * This module has no imports: the runtime, the test-runner and the unit
 * project (which has no DOM and feeds it fakes) all share it.
 */

export interface FullPageSize {
  width: number;
  height: number;
}

/**
 * How tall the page really is: the document, and every box that scrolls
 * its own content. Each scrolling box counts from its own offset, so a box
 * that starts 105px down and scrolls 3,484px asks for 3,589px plus its own
 * border and horizontal scrollbar.
 *
 * Closure-free, so the test-runner can hand it to Playwright's
 * `page.evaluate()`, which re-evaluates the function's source inside the
 * page; there it reads the real `document` and `window`. `env` exists for
 * the unit test, which has neither.
 */
export const measureContentHeight = (env?: {
  doc: Pick<Document, 'documentElement' | 'body' | 'querySelectorAll'>;
  win: Pick<Window, 'getComputedStyle' | 'scrollY'>;
}): number => {
  const doc = env?.doc ?? document;
  const win = env?.win ?? window;
  let height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
    if (el.scrollHeight <= el.clientHeight + 1) {
      continue;
    }
    const overflowY = win.getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') {
      continue;
    }
    const top = el.getBoundingClientRect().top + win.scrollY;
    const chrome = el.offsetHeight - el.clientHeight;
    height = Math.max(height, Math.ceil(top + el.scrollHeight + chrome));
  }
  return height;
};

/**
 * Grows the viewport until nothing on the page scrolls. Growing the viewport
 * re-lays the page out — a scrolling box that was 700px tall becomes 3,500px
 * and may reveal another box below it that scrolls in turn — so the height is
 * measured again after every growth, until a round asks for nothing more or
 * `maxRounds` is spent.
 *
 * A page can also ask for more because it GREW WITH the viewport: a tile
 * sized to its column, a `vh` box. Such content asks for about as much again
 * as the last growth gave it, every round, and would be chased to the cap —
 * a capture that is one screen of content over thousands of pixels of
 * stretched tile. So a round that asks for no more than the previous growth
 * is taken as content that scales, not content that was revealed, and the
 * viewport stays where it is. (Revealed content asks for its own height,
 * unrelated to the growth; it is only missed when it happens to be shorter
 * than the growth that revealed it.)
 *
 * Returns the height the viewport ended at, or `null` when it never had to
 * grow (the caller restores only in that case).
 */
export const growViewportToContent = async ({
  viewport,
  maxHeight,
  setViewport,
  measure,
  settle,
  maxRounds = 4,
}: {
  viewport: FullPageSize;
  maxHeight: number;
  setViewport: (width: number, height: number) => Promise<void>;
  measure: () => number | Promise<number>;
  settle: () => Promise<void>;
  maxRounds?: number;
}): Promise<number | null> => {
  let height = viewport.height;
  let grown = false;
  let previous: { asked: number; growth: number } | null = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const asked = Math.min(Math.ceil(await measure()), maxHeight);
    if (asked <= height) {
      break;
    }
    if (previous && asked - previous.asked <= previous.growth) {
      break;
    }
    previous = { asked, growth: asked - height };
    height = asked;
    grown = true;
    await setViewport(viewport.width, height);
    await settle();
  }
  return grown ? height : null;
};

/**
 * The browser-window half of the viewport, as the qlip plugin's browser
 * command exposes it: called without a size it answers the window's current
 * viewport, with one it resizes the window and answers the previous size.
 * `null` means the provider has no window viewport to grow — webdriverio
 * resizes the real window from `page.viewport()` itself and scales nothing.
 */
export type BrowserViewportCommand = (
  size?: FullPageSize | null,
) => Promise<FullPageSize | null>;

/**
 * The two viewports a capture sizes, and how each is put back. `set` grows
 * the window to hold the iframe whenever the iframe would not fit (never
 * shrinking it below what it was), then sizes the iframe; the window is
 * asked for its size once. `restore` puts the window back first, so the
 * iframe's pinned size is computed against the original window again, then
 * the iframe — and touches neither when neither moved.
 */
export const createCaptureViewport = ({
  pinned,
  iframe,
  window: windowViewport,
}: {
  pinned: FullPageSize;
  iframe: (width: number, height: number) => Promise<void>;
  window?: BrowserViewportCommand | undefined;
}): {
  set: (width: number, height: number) => Promise<void>;
  restore: () => Promise<void>;
} => {
  // undefined: not asked yet; null: asked, and there is no window to grow
  let base: FullPageSize | null | undefined;
  let windowAt: FullPageSize | null = null;
  let iframeAt: FullPageSize | null = null;
  const same = (a: FullPageSize, b: FullPageSize) => a.width === b.width && a.height === b.height;
  const growWindow = async (width: number, height: number) => {
    if (!windowViewport) {
      return;
    }
    if (base === undefined) {
      base = await windowViewport();
    }
    if (!base) {
      return;
    }
    const target = {
      width: Math.max(base.width, width),
      height: Math.max(base.height, height),
    };
    if (same(target, windowAt ?? base)) {
      return;
    }
    await windowViewport(target);
    windowAt = target;
  };
  return {
    set: async (width, height) => {
      await growWindow(width, height);
      await iframe(width, height);
      iframeAt = { width, height };
    },
    restore: async () => {
      if (base && windowAt && windowViewport) {
        await windowViewport(base);
        windowAt = null;
      }
      if (iframeAt && !same(iframeAt, pinned)) {
        await iframe(pinned.width, pinned.height);
        iframeAt = pinned;
      }
    },
  };
};
