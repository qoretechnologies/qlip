/**
 * `injectViewportStyles` gives Storybook's anonymous canvas <div> the full
 * viewport. The selector must not reach elements React portals into <body>:
 * a bare `body > div` stretched reqore's fixed-position floating-actions bar
 * to 100% x 100%, which captured as an opaque black rectangle. The unit
 * project runs in node with no DOM, so a minimal fake `document` records the
 * injected stylesheet.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  VIEWPORT_RESET_CSS,
  VIEWPORT_RESET_STYLE_ID,
  injectViewportStyles,
} from '../../src/runtime/setup.js';

interface FakeStyle {
  id: string;
  textContent: string;
}

function fakeDocument() {
  const head: FakeStyle[] = [];
  return {
    head: {
      children: head,
      appendChild: (el: FakeStyle) => head.push(el),
    },
    createElement: (): FakeStyle => ({ id: '', textContent: '' }),
  };
}

function useDocument(doc: ReturnType<typeof fakeDocument>) {
  (globalThis as { document?: unknown }).document = doc;
}

const selectorsOf = (css: string) =>
  css
    .slice(0, css.indexOf('{'))
    .split(',')
    .map((selector) => selector.trim());

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('injectViewportStyles', () => {
  it('appends the viewport reset stylesheet to <head>', () => {
    const doc = fakeDocument();
    useDocument(doc);
    injectViewportStyles();
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]?.id).toBe(VIEWPORT_RESET_STYLE_ID);
    expect(doc.head.children[0]?.textContent).toBe(VIEWPORT_RESET_CSS);
  });

  it('sizes the anonymous story canvas, html, body and #storybook-root', () => {
    const selectors = selectorsOf(VIEWPORT_RESET_CSS);
    expect(selectors).toEqual(
      expect.arrayContaining([
        'html',
        'body',
        '#storybook-root',
        'body > div:not([class]):not([id])',
      ]),
    );
    expect(VIEWPORT_RESET_CSS).toContain('width: 100%; height: 100%');
  });

  it('does not match arbitrary <body> children (portals keep their own size)', () => {
    const selectors = selectorsOf(VIEWPORT_RESET_CSS);
    expect(selectors).not.toContain('body > div');
    for (const selector of selectors) {
      if (selector.startsWith('body > div')) {
        expect(selector).toContain(':not([class])');
        expect(selector).toContain(':not([id])');
      }
    }
  });

  it('is a no-op without a document', () => {
    expect(() => injectViewportStyles()).not.toThrow();
  });
});
