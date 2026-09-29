/**
 * `fullPage` captures grow the viewport until nothing on the page scrolls.
 * The unit project runs in node with no DOM, so `measureContentHeight` is
 * fed a fake document, and `growViewportToContent` a scripted `measure`
 * that answers the way a real page does: each growth re-lays out the page
 * and may reveal a taller box, until a round asks for nothing more. The
 * "real pages" block runs the two together on a fake page whose layout is a
 * function of the viewport height, because which boxes grow with the
 * viewport only shows across rounds. `createCaptureViewport` is fed a fake
 * iframe and a fake browser window, because the order the two are grown and
 * restored in is the whole point.
 */

import { describe, expect, it } from 'vitest';
import {
  createCaptureViewport,
  fullPageCapWarning,
  growViewportToContent,
  measureContentHeight,
} from '../../src/runtime/fullPage.js';

interface FakeBox {
  scrollHeight: number;
  clientHeight: number;
  offsetHeight: number;
  top: number;
  overflowY: string;
}

type FakeEnv = NonNullable<NonNullable<Parameters<typeof measureContentHeight>[0]>['env']>;

/**
 * A fake page whose layout is a function of the viewport height: resizing
 * it re-lays it out, the way `setViewport` re-lays out a real page. Each box
 * stays the same object across layouts, as a DOM element does.
 */
const fakePage = (
  layout: (viewport: number) => { docHeight: number; boxes: FakeBox[] },
  initialViewport = 844,
) => {
  let viewport = initialViewport;
  const box = (index: number): FakeBox => {
    const current = layout(viewport).boxes[index];
    if (!current) throw new Error(`no box ${String(index)} at ${String(viewport)}px`);
    return current;
  };
  const elements = layout(viewport).boxes.map((_, index) => ({
    get scrollHeight() {
      return box(index).scrollHeight;
    },
    get clientHeight() {
      return box(index).clientHeight;
    },
    get offsetHeight() {
      return box(index).offsetHeight;
    },
    getBoundingClientRect: () => ({ top: box(index).top }),
    get __overflowY() {
      return box(index).overflowY;
    },
  }));
  const env = {
    doc: {
      documentElement: {
        get scrollHeight() {
          return layout(viewport).docHeight;
        },
      },
      body: {
        get scrollHeight() {
          return layout(viewport).docHeight;
        },
      },
      querySelectorAll: () => elements,
    },
    win: {
      scrollY: 0,
      get innerHeight() {
        return viewport;
      },
      getComputedStyle: (el: { __overflowY: string }) => ({ overflowY: el.__overflowY }),
    },
  } as unknown as FakeEnv;
  const resized: number[] = [];
  return {
    env,
    resized,
    setViewport: (_width: number, height: number) => {
      viewport = height;
      resized.push(height);
      return Promise.resolve();
    },
  };
};

/** One layout, measured once. */
const fakeDom = (docHeight: number, boxes: FakeBox[]) =>
  fakePage(() => ({ docHeight, boxes })).env;

/** Grows `page` for a phone capture, measuring the fake page for real. */
const growPhone = (page: ReturnType<typeof fakePage>, maxHeight = 10000) =>
  growViewportToContent({
    viewport: { width: 390, height: 844 },
    maxHeight,
    setViewport: page.setViewport,
    measure: (first) => measureContentHeight({ reset: first, env: page.env }),
    settle: () => Promise.resolve(),
  });

describe('measureContentHeight', () => {
  it('asks for nothing when nothing scrolls', () => {
    const env = fakeDom(844, [
      { scrollHeight: 400, clientHeight: 400, offsetHeight: 400, top: 0, overflowY: 'auto' },
    ]);
    expect(measureContentHeight({ reset: true, env })).toBe(0);
  });

  it('is the document height when the document itself scrolls', () => {
    expect(measureContentHeight({ reset: true, env: fakeDom(3000, []) })).toBe(3000);
  });

  it('asks for the viewport plus what a scrolling box hides', () => {
    // The marketplace at phone width: the document is one screen, a box 105px
    // down shows 711px of its 3,484px, and 26px of page sit below it. The
    // viewport must grow by the 2,773px the box hides, footer or not.
    const env = fakeDom(844, [
      { scrollHeight: 3484, clientHeight: 711, offsetHeight: 713, top: 105, overflowY: 'auto' },
    ]);
    expect(measureContentHeight({ reset: true, env })).toBe(844 + (3484 - 711));
  });

  it('ignores overflow that is clipped or visible', () => {
    const env = fakeDom(844, [
      { scrollHeight: 5000, clientHeight: 300, offsetHeight: 300, top: 0, overflowY: 'hidden' },
      { scrollHeight: 5000, clientHeight: 300, offsetHeight: 300, top: 0, overflowY: 'visible' },
    ]);
    expect(measureContentHeight({ reset: true, env })).toBe(0);
  });

  it('takes the tallest of several scrolling boxes', () => {
    const env = fakeDom(844, [
      { scrollHeight: 1416, clientHeight: 515, offsetHeight: 515, top: 313, overflowY: 'auto' },
      { scrollHeight: 900, clientHeight: 200, offsetHeight: 200, top: 40, overflowY: 'scroll' },
    ]);
    expect(measureContentHeight({ reset: true, env })).toBe(844 + (1416 - 515));
  });

  it('starts a new memory on reset, so one capture never leaks into the next', async () => {
    // The first capture learns that this 200px box keeps its height; the
    // next capture on the same page must measure it afresh.
    const page = fakePage(() => ({
      docHeight: 844,
      boxes: [{ scrollHeight: 2000, clientHeight: 200, offsetHeight: 202, top: 76, overflowY: 'auto' }],
    }));
    await growPhone(page);
    expect(measureContentHeight({ env: page.env })).toBe(0);
    expect(measureContentHeight({ reset: true, env: page.env })).toBe(844 + (2000 - 200));
  });
});

describe('growViewportToContent', () => {
  const viewport = { width: 390, height: 844 };

  it('leaves a page that fits alone', async () => {
    const calls: number[] = [];
    const growth = await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => 800,
      settle: () => Promise.resolve(),
    });
    expect(growth).toEqual({ height: 844, wanted: 800 });
    expect(calls).toEqual([]);
  });

  it('grows until a round asks for nothing more', async () => {
    // Round 1 sees 1733px; the taller page reveals a second box asking for
    // 4600px; the third round asks for nothing more.
    const answers = [1733, 4600, 4600];
    const calls: number[] = [];
    const growth = await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: (w, h) => {
        expect(w).toBe(390);
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => answers.shift() ?? 4200,
      settle: () => Promise.resolve(),
    });
    expect(growth).toEqual({ height: 4600, wanted: 4600 });
    expect(calls).toEqual([1733, 4600]);
  });

  it('gives back growth the content turned out not to need', async () => {
    // Round 1 grows for a box; round 2 finds the box kept its own height and
    // asks for nothing, so the viewport goes back to the pinned height.
    const answers = [2078, 0];
    const calls: number[] = [];
    const growth = await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => answers.shift() ?? 0,
      settle: () => Promise.resolve(),
    });
    expect(growth).toEqual({ height: 844, wanted: 0 });
    expect(calls).toEqual([2078, 844]);
  });

  it('caps at the maximum height, and says what the content wanted', async () => {
    const calls: number[] = [];
    const growth = await growViewportToContent({
      viewport,
      maxHeight: 6000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => 20000,
      settle: () => Promise.resolve(),
    });
    expect(growth).toEqual({ height: 6000, wanted: 20000 });
    expect(calls).toEqual([6000]);
  });

  it('tells measure which round starts the capture', async () => {
    const firsts: boolean[] = [];
    const answers = [2000, 4000, 4000];
    await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: () => Promise.resolve(),
      measure: (first) => {
        firsts.push(first);
        return answers.shift() ?? 4000;
      },
      settle: () => Promise.resolve(),
    });
    expect(firsts).toEqual([true, false, false]);
  });

  it('settles after every growth so the next measure sees the new layout', async () => {
    const order: string[] = [];
    const answers = [2000, 4000, 4000];
    await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: () => {
        order.push('resize');
        return Promise.resolve();
      },
      measure: () => {
        order.push('measure');
        return answers.shift() ?? 3000;
      },
      settle: () => {
        order.push('settle');
        return Promise.resolve();
      },
    });
    expect(order).toEqual(['measure', 'resize', 'settle', 'measure', 'resize', 'settle', 'measure']);
  });
});

describe('fullPage on real pages (the loop and the measure together)', () => {
  /** An app shell: header, then a column that fills the viewport and scrolls. */
  const column = (viewport: number, content: number): FakeBox => ({
    top: 56,
    clientHeight: viewport - 56,
    offsetHeight: viewport - 56,
    scrollHeight: Math.max(viewport - 56, content),
    overflowY: 'auto',
  });

  it("grows an app shell until its column shows all of it", async () => {
    const page = fakePage((v) => ({ docHeight: v, boxes: [column(v, 2880)] }));
    expect(await growPhone(page)).toEqual({ height: 56 + 2880, wanted: 56 + 2880 });
    expect(page.resized).toEqual([2936]);
  });

  it('leaves a fixed-height box scrolled and gives back the growth it asked for', async () => {
    // An ordinary page whose only scroller is a 200px box holding 2,000px:
    // growing the viewport never grows the box, so the capture stays one
    // screen rather than a screen of page over a tall blank strip.
    const page = fakePage((v) => ({
      docHeight: v,
      boxes: [{ top: 76, clientHeight: 200, offsetHeight: 202, scrollHeight: 2000, overflowY: 'auto' }],
    }));
    expect((await growPhone(page)).height).toBe(844);
    expect(page.resized).toEqual([844 + 1800, 844]);
  });

  it('grows for the column but not for a fixed box inside it', async () => {
    // A 300px code block holding 9,000px sits in the column: the first round
    // grows for it, the second finds it kept its height and settles on the
    // column's own content.
    const page = fakePage((v) => ({
      docHeight: v,
      boxes: [
        column(v, 2880),
        { top: 300, clientHeight: 300, offsetHeight: 300, scrollHeight: 9000, overflowY: 'auto' },
      ],
    }));
    expect((await growPhone(page)).height).toBe(2936);
    expect(page.resized).toEqual([844 + 8700, 2936]);
  });

  it('stops chasing a column whose content grows with it', async () => {
    // The template drawer at phone width: its flow tile is sized to the
    // column, so every growth makes the column ask for 889px more. The
    // first growth is real (the column's own content); after that the
    // column's hidden content stays 889px however tall it gets.
    const page = fakePage((v) => ({ docHeight: v, boxes: [column(v, v - 56 + 889)] }));
    expect((await growPhone(page)).height).toBe(1733);
    expect(page.resized).toEqual([1733]);
  });

  it('keeps growing when a growth reveals less than it added', async () => {
    // Growing to 1,733px shows a 300px section that was not there before —
    // less than the 889px the growth added, but real content all the same.
    const page = fakePage((v) => ({
      docHeight: v,
      boxes: [column(v, 1677 + (v >= 1733 ? 300 : 0))],
    }));
    expect((await growPhone(page)).height).toBe(2033);
    expect(page.resized).toEqual([1733, 2033]);
  });

  it("keeps a scrolling document's own height once the viewport outgrows it", async () => {
    // A 3,000px document with a fixed box that asks for 5,000px: past the
    // first growth the document's scrollHeight is just the viewport, so the
    // give-back goes to the 3,000px it had while it still scrolled.
    const page = fakePage((v) => ({
      docHeight: Math.max(v, 3000),
      boxes: [{ top: 100, clientHeight: 300, offsetHeight: 300, scrollHeight: 4900, overflowY: 'auto' }],
    }));
    expect((await growPhone(page)).height).toBe(3000);
    expect(page.resized).toEqual([844 + 4600, 3000]);
  });

  it('does not chase a document whose content grows with the viewport', async () => {
    // A 100vh hero over 2,156px of page: every growth makes the hero taller
    // by as much, so the document never stops scrolling.
    const page = fakePage((v) => ({ docHeight: v + 2156, boxes: [] }));
    expect((await growPhone(page)).height).toBe(3000);
    expect(page.resized).toEqual([3000]);
  });
});

describe('fullPageCapWarning', () => {
  it('says nothing when the page fit under the cap', () => {
    expect(fullPageCapWarning('a--story', { height: 5000, wanted: 5000 }, 10000)).toBeNull();
  });

  it('names the story, its height and the cap when the cap cut it short', () => {
    const warning = fullPageCapWarning('feed--mobile', { height: 6000, wanted: 20000 }, 6000);
    expect(warning).toContain('[qlip] fullPage: feed--mobile is 20000px tall');
    expect(warning).toContain('the 6000px cap');
    expect(warning).toContain('fullPageMaxHeight');
  });
});

describe('createCaptureViewport', () => {
  const pinned = { width: 390, height: 844 };
  const fakes = (windowSize: { width: number; height: number } | null) => {
    const log: string[] = [];
    let current = windowSize;
    return {
      log,
      iframe: (width: number, height: number) => {
        log.push(`iframe ${width}x${height}`);
        return Promise.resolve();
      },
      window: (size?: { width: number; height: number } | null) => {
        const previous = current;
        if (size && current) {
          log.push(`window ${size.width}x${size.height}`);
          current = size;
        } else {
          log.push('window?');
        }
        return Promise.resolve(previous);
      },
    };
  };

  it('grows the window before the iframe, asks its size once, and restores the window first', async () => {
    const { log, iframe, window } = fakes({ width: 2560, height: 1440 });
    const viewport = createCaptureViewport({ pinned, iframe, window });
    await viewport.set(390, 844);
    await viewport.set(390, 3589);
    await viewport.set(390, 4200);
    await viewport.restore();
    expect(log).toEqual([
      'window?',
      'iframe 390x844',
      'window 2560x3589',
      'iframe 390x3589',
      'window 2560x4200',
      'iframe 390x4200',
      'window 2560x1440',
      'iframe 390x844',
    ]);
  });

  it('grows the window for a pinned viewport the window cannot hold, so the capture is not scaled', async () => {
    // qlip's own demo: a 1280x720 window and an 844px-tall phone story.
    const { log, iframe, window } = fakes({ width: 1280, height: 720 });
    const viewport = createCaptureViewport({ pinned, iframe, window });
    await viewport.set(390, 844);
    await viewport.restore();
    expect(log).toEqual(['window?', 'window 1280x844', 'iframe 390x844', 'window 1280x720']);
  });

  it('never shrinks the window, and does not touch what it did not move', async () => {
    const { log, iframe, window } = fakes({ width: 2560, height: 1440 });
    const viewport = createCaptureViewport({ pinned, iframe, window });
    await viewport.set(390, 844);
    await viewport.restore();
    expect(log).toEqual(['window?', 'iframe 390x844']);
  });

  it('touches only the iframe when the provider has no window viewport', async () => {
    const { log, iframe, window } = fakes(null);
    const viewport = createCaptureViewport({ pinned, iframe, window });
    await viewport.set(390, 3589);
    await viewport.restore();
    expect(log).toEqual(['window?', 'iframe 390x3589', 'iframe 390x844']);
  });

  it('touches only the iframe when there is no window command at all', async () => {
    const { log, iframe } = fakes(null);
    const viewport = createCaptureViewport({ pinned, iframe });
    await viewport.set(390, 3589);
    await viewport.restore();
    expect(log).toEqual(['iframe 390x3589', 'iframe 390x844']);
  });
});
