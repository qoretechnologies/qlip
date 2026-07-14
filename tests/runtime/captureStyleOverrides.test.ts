/**
 * `applyCaptureStyleOverrides` injects the capture-time stylesheet that
 * kills animations and — the reason this exists — strips
 * `backdrop-filter`, which headless Chromium renders as an opaque black
 * rectangle. The unit project runs in node with no DOM, so we stand up a
 * minimal fake `document` that supports the handful of calls the
 * function makes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { applyCaptureStyleOverrides } from '../../src/runtime/screenshot.js';

const STYLE_ID = '__qlip-capture-style-overrides';

interface FakeStyle {
  id: string;
  textContent: string;
  remove: () => void;
}

function fakeDocument() {
  const byId = new Map<string, FakeStyle>();
  const doc = {
    getElementById: (id: string): FakeStyle | null => byId.get(id) ?? null,
    createElement: (): FakeStyle => {
      const el: FakeStyle = {
        id: '',
        textContent: '',
        remove: () => byId.delete(el.id),
      };
      return el;
    },
    head: {
      appendChild: (el: FakeStyle) => byId.set(el.id, el),
    },
  };
  return doc;
}

function useDocument(doc: ReturnType<typeof fakeDocument>) {
  (globalThis as { document?: unknown }).document = doc;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('applyCaptureStyleOverrides', () => {
  it('strips backdrop-filter for the capture (the headless black-box fix)', () => {
    const doc = fakeDocument();
    useDocument(doc);
    applyCaptureStyleOverrides({
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
      disableBackdropFilter: true,
    });
    const css = doc.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('backdrop-filter: none !important');
    expect(css).toContain('-webkit-backdrop-filter: none !important');
  });

  it('combines animation disabling with the backdrop-filter strip', () => {
    const doc = fakeDocument();
    useDocument(doc);
    applyCaptureStyleOverrides({
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
      disableBackdropFilter: true,
    });
    const css = doc.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('animation: none !important');
    expect(css).toContain('backdrop-filter: none !important');
  });

  it('keeps backdrop-filter when the option is off', () => {
    const doc = fakeDocument();
    useDocument(doc);
    applyCaptureStyleOverrides({
      disableAnimations: true,
      pauseAnimationsAtEnd: false,
      disableBackdropFilter: false,
    });
    const css = doc.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('animation: none !important');
    expect(css).not.toContain('backdrop-filter');
  });

  it('injects nothing when every override is off', () => {
    const doc = fakeDocument();
    useDocument(doc);
    applyCaptureStyleOverrides({
      disableAnimations: false,
      pauseAnimationsAtEnd: false,
      disableBackdropFilter: false,
    });
    expect(doc.getElementById(STYLE_ID)).toBeNull();
  });
});
