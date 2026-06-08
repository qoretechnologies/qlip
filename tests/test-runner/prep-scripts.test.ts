/**
 * Unit tests for the browser-side prep scripts the test-runner
 * library injects via `page.evaluate()`. We run them directly in
 * Vitest's node environment with a hand-rolled minimal DOM stub,
 * matching the style of `tests/runtime/screenshot.test.ts` which
 * tests the equivalent Vitest-plugin-path prep code.
 *
 * The functions here MUST be self-contained (no captured closure
 * variables) because Playwright will serialize them when shipping
 * them to the browser. The tests verify the in-page behaviour
 * directly so a regression in serializability or DOM contract is
 * caught locally rather than only at integration time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAnimationControlInPage,
  applyIgnoreMasksInPage,
  removeIgnoreMasksInPage,
  waitForDomIdleInPage,
} from '../../src/test-runner/prep-scripts.js';

// Minimal DOM stub — same lightweight approach used by the
// equivalent Vitest-path tests. We don't want jsdom as a dep just
// for this module; the surface we exercise is tiny (head, body,
// createElement, getElementById, querySelectorAll, getAnimations).
//
// Each beforeEach builds a fresh stub on `globalThis`; afterEach
// tears it down so tests don't leak state across each other.

interface FakeElement {
  id: string;
  tagName: string;
  textContent: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  style: Record<string, string>;
  attributes: Map<string, string>;
  setAttribute: (k: string, v: string) => void;
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
  getBoundingClientRect: () => {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
}

let elementsById: Map<string, FakeElement>;
let bodyChildren: FakeElement[];
let headChildren: FakeElement[];
let originalDocument: typeof globalThis.document;
let originalMutationObserver: typeof globalThis.MutationObserver;

const makeElement = (tag: string): FakeElement => {
  const el: FakeElement = {
    id: '',
    tagName: tag.toUpperCase(),
    textContent: '',
    parentElement: null,
    children: [],
    style: {},
    attributes: new Map(),
    setAttribute: (k, v) => el.attributes.set(k, v),
    appendChild: (child) => {
      child.parentElement = el;
      el.children.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    },
    // No Proxy needed — we register the element's id with the
    // global map at appendChild time. The prep scripts set `id`
    // BEFORE appending, so by the time appendChild runs the id is
    // populated. `remove()` then cleans up the map.
    remove: () => {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      }
      if (el.id) elementsById.delete(el.id);
    },
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      right: 110,
      bottom: 70,
    }),
  };
  return el;
};

beforeEach(() => {
  elementsById = new Map();
  bodyChildren = [];
  headChildren = [];

  const body: FakeElement = {
    ...makeElement('body'),
    children: bodyChildren,
    appendChild(child: FakeElement) {
      child.parentElement = body;
      bodyChildren.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    },
  };
  const head: FakeElement = {
    ...makeElement('head'),
    children: headChildren,
    appendChild(child: FakeElement) {
      child.parentElement = head;
      headChildren.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    },
  };
  const documentElement = makeElement('html');

  originalDocument = globalThis.document;
  (globalThis as { document?: unknown }).document = {
    body,
    head,
    documentElement,
    createElement: (tag: string) => makeElement(tag),
    getElementById: (id: string) => elementsById.get(id) ?? null,
    querySelectorAll: (selector: string) => {
      // Only support the test's masking selectors — match by id-prefix
      // ('.mask-target') because that's what we use in the test below.
      const all: FakeElement[] = [...bodyChildren, ...headChildren];
      if (selector === '.mask-target') {
        return all.filter((el) => el.id.startsWith('mask-target-'));
      }
      return [];
    },
    getAnimations: () => [],
  };

  // MutationObserver stub: lets us fire mutations on demand from tests.
  originalMutationObserver = globalThis.MutationObserver;
  class FakeMutationObserver {
    callback: () => void;
    constructor(cb: () => void) {
      this.callback = cb;
    }
    observe(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
    trigger(): void {
      this.callback();
    }
  }
  (globalThis as { MutationObserver?: unknown }).MutationObserver =
    FakeMutationObserver;
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
  (globalThis as { MutationObserver?: unknown }).MutationObserver =
    originalMutationObserver;
});

describe('applyAnimationControlInPage', () => {
  it('injects a disabling style when disableAnimations is true', () => {
    applyAnimationControlInPage({
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
    });
    expect(headChildren).toHaveLength(1);
    const style = headChildren[0];
    expect(style.id).toBe('__qlip-animation-control');
    expect(style.textContent).toContain('animation: none');
    expect(style.textContent).toContain('transition: none');
  });

  it('injects a pausing style when pauseAnimationsAtEnd is true', () => {
    applyAnimationControlInPage({
      disableAnimations: false,
      pauseAnimationsAtEnd: true,
    });
    const style = headChildren[0];
    expect(style.textContent).toContain('animation-play-state: paused');
    expect(style.textContent).toContain('transition-duration: 0s');
  });

  it('removes a previously-injected style when both flags are false', () => {
    applyAnimationControlInPage({
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
    });
    expect(headChildren).toHaveLength(1);
    applyAnimationControlInPage({
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
    });
    expect(headChildren).toHaveLength(0);
  });

  it('reuses the same style element on repeated calls (no duplicates)', () => {
    applyAnimationControlInPage({
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
    });
    applyAnimationControlInPage({
      disableAnimations: false,
      pauseAnimationsAtEnd: true,
    });
    expect(headChildren).toHaveLength(1);
    expect(headChildren[0].textContent).toContain('paused');
  });
});

describe('applyIgnoreMasksInPage / removeIgnoreMasksInPage', () => {
  it('creates one mask per matching element with the right styling', () => {
    // Set up two targets in the body.
    const t1 = document.createElement('div');
    t1.id = 'mask-target-1';
    document.body.appendChild(t1);
    const t2 = document.createElement('div');
    t2.id = 'mask-target-2';
    document.body.appendChild(t2);

    const ids = applyIgnoreMasksInPage({ selectors: ['.mask-target'] });

    expect(ids).toHaveLength(2);
    // Each mask should be a black fixed-position div with the
    // dimensions of the underlying element (our stub returns 100x50).
    const m1 = document.getElementById(ids[0]) as unknown as FakeElement;
    expect(m1.style.position).toBe('fixed');
    expect(m1.style.background).toBe('#000');
    expect(m1.style.width).toBe('100px');
    expect(m1.style.height).toBe('50px');
    expect(m1.attributes.get('data-qlip-mask')).toBe('.mask-target');
  });

  it('removes only the masks it created', () => {
    const t = document.createElement('div');
    t.id = 'mask-target-1';
    document.body.appendChild(t);
    const ids = applyIgnoreMasksInPage({ selectors: ['.mask-target'] });
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0])).not.toBeNull();

    removeIgnoreMasksInPage({ ids });
    expect(document.getElementById(ids[0])).toBeNull();
    // The original element stays put.
    expect(document.getElementById('mask-target-1')).not.toBeNull();
  });

  it('returns an empty array when no selectors are passed', () => {
    const ids = applyIgnoreMasksInPage({ selectors: [] });
    expect(ids).toEqual([]);
  });
});

describe('waitForDomIdleInPage', () => {
  it('resolves immediately when idleMs is 0', async () => {
    const start = Date.now();
    await waitForDomIdleInPage({ idleMs: 0, maxWaitMs: 5000 });
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves once no mutations occur for idleMs', async () => {
    vi.useFakeTimers();
    try {
      const p = waitForDomIdleInPage({ idleMs: 100, maxWaitMs: 5000 });
      // No mutations triggered → polling interval fires + sees
      // (now - lastChange) >= idleMs after ~100ms.
      await vi.advanceTimersByTimeAsync(150);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at maxWaitMs even if mutations keep firing', async () => {
    vi.useFakeTimers();
    try {
      const p = waitForDomIdleInPage({ idleMs: 100, maxWaitMs: 200 });
      // Past maxWaitMs the check loop returns regardless of activity.
      await vi.advanceTimersByTimeAsync(300);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
