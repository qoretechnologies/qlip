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
 * What `measureContentHeight` remembers between the rounds of one capture,
 * kept on the page's `window` so it survives the test-runner's separate
 * `page.evaluate()` calls too.
 */
interface ContentMeasureMemory {
  /** `innerHeight` at the last measure, to tell that the viewport grew. */
  viewport: number;
  /** The tallest the document has been while it scrolled on its own. */
  docHeight: number;
  /** How far the document scrolled at the last measure. */
  docOverflow: number;
  /** The document's own content grows with the viewport (a `vh` hero). */
  docScales: boolean;
  /**
   * Each scrolling box when last measured: its height, how much it hid, its
   * content height while it still scrolled, and what it last asked for.
   */
  boxes: WeakMap<
    Element,
    { clientHeight: number; overflow: number; content: number; need: number }
  >;
  /** Boxes that kept their height when the viewport grew. */
  fixed: WeakSet<Element>;
  /** Boxes whose content grew as much as they did. */
  scales: WeakSet<Element>;
}

/**
 * How tall the page needs the viewport to be for nothing on it to scroll:
 * the document, and every box that scrolls its own content. A scrolling box
 * asks for the viewport plus whatever it hides — a box that fills the
 * viewport grows with it one for one, whatever sits above or below it — and
 * a box that already fits asks for the viewport minus its spare room.
 * Answers 0 when nothing scrolls.
 *
 * A box only counts while growing the viewport can still reveal it, which
 * only a re-measure after a growth can tell, so the rounds of one capture
 * share a memory (`reset` starts a new one):
 * - A box that kept its height when the viewport grew has a height of its
 *   own (a 200px code block, a capped list). More viewport never reveals its
 *   content, so it stops counting, and growth it asked for is given back.
 * - A box whose content grew as much as the box did is sized to it (a tile
 *   that follows its column). Chasing it only stretches the tile, so it keeps
 *   asking for what it asked before it scaled. The document gets the same
 *   test (a `vh` hero).
 * - A box whose hidden content shrank was revealed and keeps counting, even
 *   when a growth reveals less than it added.
 *
 * The document's own `scrollHeight` is the viewport again once the viewport
 * outgrows it, so its tallest height while it still scrolled is remembered.
 *
 * Closure-free, so the test-runner can hand it to Playwright's
 * `page.evaluate()`, which re-evaluates the function's source inside the
 * page; there it reads the real `document` and `window`. `env` exists for
 * the unit test, which has neither.
 */
export const measureContentHeight = (options?: {
  reset?: boolean;
  env?: {
    doc: Pick<Document, 'documentElement' | 'body' | 'querySelectorAll'>;
    win: Pick<Window, 'getComputedStyle' | 'innerHeight'>;
  };
}): number => {
  const doc = options?.env?.doc ?? document;
  const win = options?.env?.win ?? window;
  const holder = win as unknown as { __qlipFullPage?: ContentMeasureMemory };
  if (options?.reset || !holder.__qlipFullPage) {
    holder.__qlipFullPage = {
      viewport: 0,
      docHeight: 0,
      docOverflow: 0,
      docScales: false,
      boxes: new WeakMap(),
      fixed: new WeakSet(),
      scales: new WeakSet(),
    };
  }
  const memory = holder.__qlipFullPage;
  const viewport = win.innerHeight;
  const grew = memory.viewport > 0 && viewport > memory.viewport + 1;

  const docScroll = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
  const docOverflow = Math.max(0, docScroll - viewport);
  if (grew && memory.docOverflow > 0 && docOverflow >= memory.docOverflow - 1) {
    memory.docScales = true;
  }
  memory.docOverflow = docOverflow;
  if (docOverflow > 1 && !memory.docScales) {
    memory.docHeight = Math.max(memory.docHeight, docScroll);
  }
  let height = memory.docHeight;

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
    const seen = memory.boxes.get(el);
    if (!seen) {
      if (el.scrollHeight <= el.clientHeight + 1) {
        continue;
      }
      const overflowY = win.getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') {
        continue;
      }
    }
    const overflow = Math.max(0, el.scrollHeight - el.clientHeight);
    if (seen && grew) {
      if (el.clientHeight <= seen.clientHeight + 1) {
        memory.fixed.add(el);
      } else if (seen.overflow > 0 && overflow >= seen.overflow - 1) {
        memory.scales.add(el);
      }
    }
    if (memory.fixed.has(el)) {
      continue;
    }
    // A box that fits reports its own height as scrollHeight, so its content
    // height is the one it had while it still scrolled.
    const content =
      overflow > 1 ? Math.max(seen?.content ?? 0, el.scrollHeight) : (seen?.content ?? el.scrollHeight);
    let need: number;
    if (seen && memory.scales.has(el)) {
      need = seen.need;
    } else if (overflow > 1) {
      need = viewport + overflow;
    } else {
      need = viewport - Math.max(0, el.clientHeight - content);
    }
    need = Math.ceil(need);
    memory.boxes.set(el, { clientHeight: el.clientHeight, overflow, content, need });
    height = Math.max(height, need);
  }
  memory.viewport = viewport;
  return height;
};

/** Where `growViewportToContent` left the viewport, and why. */
export interface FullPageGrowth {
  /** The height the viewport ended at: the pinned height when nothing grew. */
  height: number;
  /** What the content last asked for, before the `maxHeight` cap. */
  wanted: number;
}

/**
 * Grows the viewport until nothing on the page scrolls. Growing the viewport
 * re-lays the page out — a scrolling box that was 700px tall becomes 3,500px
 * and may reveal another box below it that scrolls in turn — so the height is
 * measured again after every growth, until a round asks for nothing more or
 * `maxRounds` is spent. Content that does not grow with the viewport, or
 * grows with it, is `measure`'s call (see `measureContentHeight`); when a
 * round asks for less than the viewport already is, that growth went to such
 * a box, and it is given back.
 *
 * `measure` is told when it is the capture's first round, so it can start a
 * new memory.
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
  measure: (first: boolean) => number | Promise<number>;
  settle: () => Promise<void>;
  maxRounds?: number;
}): Promise<FullPageGrowth> => {
  let height = viewport.height;
  let wanted = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    wanted = Math.ceil(await measure(round === 0));
    const asked = Math.min(Math.max(wanted, viewport.height), maxHeight);
    if (asked === height) {
      break;
    }
    const givingBack = asked < height;
    height = asked;
    await setViewport(viewport.width, height);
    await settle();
    if (givingBack) {
      // Every box still counted asked for no more than this, so it fits.
      break;
    }
  }
  return { height, wanted };
};

/**
 * The warning for a `fullPage` capture the height cap cut short, or `null`:
 * a page taller than `fullPageMaxHeight` is captured at the cap, and a cut-off
 * page must not pass for the whole one.
 */
export const fullPageCapWarning = (
  storyId: string,
  growth: FullPageGrowth,
  maxHeight: number,
): string | null =>
  growth.wanted > maxHeight
    ? `[qlip] fullPage: ${storyId} is ${String(growth.wanted)}px tall but was captured at ` +
      `the ${String(maxHeight)}px cap; raise fullPageMaxHeight (Chromium allows up to 16384) ` +
      'to capture all of it.'
    : null;

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
