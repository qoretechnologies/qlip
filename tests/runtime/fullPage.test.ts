/**
 * `fullPage` captures grow the viewport until nothing on the page scrolls.
 * The unit project runs in node with no DOM, so `measureContentHeight` is
 * fed a fake document, and `growViewportToContent` a scripted `measure`
 * that answers the way a real page does: each growth re-lays out the page
 * and may reveal a taller box, until a round asks for nothing more.
 * `createCaptureViewport` is fed a fake iframe and a fake browser window,
 * because the order the two are grown and restored in is the whole point.
 */

import { describe, expect, it } from 'vitest';
import {
  createCaptureViewport,
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

const fakeDom = (docHeight: number, boxes: FakeBox[]) => {
  const elements = boxes.map((box) => ({
    scrollHeight: box.scrollHeight,
    clientHeight: box.clientHeight,
    offsetHeight: box.offsetHeight,
    getBoundingClientRect: () => ({ top: box.top }),
    __overflowY: box.overflowY,
  }));
  const doc = {
    documentElement: { scrollHeight: docHeight },
    body: { scrollHeight: docHeight },
    querySelectorAll: () => elements,
  } as unknown as Pick<Document, 'documentElement' | 'body' | 'querySelectorAll'>;
  const win = {
    scrollY: 0,
    getComputedStyle: (el: { __overflowY: string }) => ({ overflowY: el.__overflowY }),
  } as unknown as Pick<Window, 'getComputedStyle' | 'scrollY'>;
  return { doc, win };
};

describe('measureContentHeight', () => {
  it('is the document height when nothing scrolls', () => {
    const { doc, win } = fakeDom(844, [
      { scrollHeight: 400, clientHeight: 400, offsetHeight: 400, top: 0, overflowY: 'auto' },
    ]);
    expect(measureContentHeight({ doc, win })).toBe(844);
  });

  it('counts a scrolling box from its offset, with its own chrome', () => {
    // The marketplace at phone width: the document is one screen, a box 105px
    // down scrolls 3484px of content behind a 711px window.
    const { doc, win } = fakeDom(844, [
      { scrollHeight: 3484, clientHeight: 711, offsetHeight: 713, top: 105, overflowY: 'auto' },
    ]);
    expect(measureContentHeight({ doc, win })).toBe(105 + 3484 + 2);
  });

  it('ignores overflow that is clipped or visible', () => {
    const { doc, win } = fakeDom(844, [
      { scrollHeight: 5000, clientHeight: 300, offsetHeight: 300, top: 0, overflowY: 'hidden' },
      { scrollHeight: 5000, clientHeight: 300, offsetHeight: 300, top: 0, overflowY: 'visible' },
    ]);
    expect(measureContentHeight({ doc, win })).toBe(844);
  });

  it('takes the tallest of several scrolling boxes', () => {
    const { doc, win } = fakeDom(844, [
      { scrollHeight: 1416, clientHeight: 515, offsetHeight: 515, top: 313, overflowY: 'auto' },
      { scrollHeight: 900, clientHeight: 200, offsetHeight: 200, top: 40, overflowY: 'scroll' },
    ]);
    expect(measureContentHeight({ doc, win })).toBe(313 + 1416);
  });
});

describe('growViewportToContent', () => {
  const viewport = { width: 390, height: 844 };

  it('leaves a page that fits alone', async () => {
    const calls: number[] = [];
    const grown = await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => 800,
      settle: () => Promise.resolve(),
    });
    expect(grown).toBeNull();
    expect(calls).toEqual([]);
  });

  it('grows until a round asks for nothing more', async () => {
    // Round 1 sees 1733px; the taller page reveals a second box asking for
    // 4600px — far more than the 889px of growth, so it is real content; the
    // third round asks for nothing more.
    const answers = [1733, 4600, 4600];
    const calls: number[] = [];
    const grown = await growViewportToContent({
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
    expect(grown).toBe(4600);
    expect(calls).toEqual([1733, 4600]);
  });

  it('stops chasing content that grows with the viewport', async () => {
    // The template drawer at phone width: its flow tile is sized to the
    // drawer column, so 889px of growth makes the column ask for 889px more,
    // and would every round until the cap. The first growth is real (the
    // column's own content); the second is the tile stretching.
    const answers = [1733, 2622, 3511, 4400];
    const calls: number[] = [];
    const grown = await growViewportToContent({
      viewport,
      maxHeight: 10000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => answers.shift() ?? 4400,
      settle: () => Promise.resolve(),
    });
    expect(grown).toBe(1733);
    expect(calls).toEqual([1733]);
  });

  it('caps at the maximum height', async () => {
    const calls: number[] = [];
    const grown = await growViewportToContent({
      viewport,
      maxHeight: 6000,
      setViewport: (_w, h) => {
        calls.push(h);
        return Promise.resolve();
      },
      measure: () => 20000,
      settle: () => Promise.resolve(),
    });
    expect(grown).toBe(6000);
    expect(calls).toEqual([6000]);
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
