/**
 * The `qlipBrowserViewport` command runs in the Vitest server process and
 * resizes the Playwright context viewport for a `fullPage` capture. It is
 * fed a fake command context: a Playwright page, or none.
 */

import { describe, expect, it } from 'vitest';
import { qlipBrowserViewport } from '../../src/plugin/browserViewport.js';

const fakeContext = (provider: string, viewport: { width: number; height: number } | null) => {
  const sets: { width: number; height: number }[] = [];
  let current = viewport;
  const page = {
    viewportSize: () => current,
    setViewportSize: (size: { width: number; height: number }) => {
      sets.push(size);
      current = size;
      return Promise.resolve();
    },
  };
  return { sets, context: { provider: { name: provider }, page } };
};

describe('qlipBrowserViewport', () => {
  it('answers the current size without changing anything', async () => {
    const { sets, context } = fakeContext('playwright', { width: 2560, height: 1440 });
    await expect(qlipBrowserViewport(context as never)).resolves.toEqual({
      width: 2560,
      height: 1440,
    });
    expect(sets).toEqual([]);
  });

  it('resizes the page and answers the size it had before', async () => {
    const { sets, context } = fakeContext('playwright', { width: 2560, height: 1440 });
    await expect(
      qlipBrowserViewport(context as never, { width: 2560, height: 3589 }),
    ).resolves.toEqual({ width: 2560, height: 1440 });
    expect(sets).toEqual([{ width: 2560, height: 3589 }]);
    await expect(qlipBrowserViewport(context as never)).resolves.toEqual({
      width: 2560,
      height: 3589,
    });
  });

  it('does not resize to the size the page already has', async () => {
    const { sets, context } = fakeContext('playwright', { width: 2560, height: 1440 });
    await qlipBrowserViewport(context as never, { width: 2560, height: 1440 });
    expect(sets).toEqual([]);
  });

  it('answers null for a context without a viewport, and touches nothing', async () => {
    const { sets, context } = fakeContext('playwright', null);
    await expect(
      qlipBrowserViewport(context as never, { width: 2560, height: 3589 }),
    ).resolves.toBeNull();
    expect(sets).toEqual([]);
  });

  it('answers null for another provider', async () => {
    const { sets, context } = fakeContext('webdriverio', { width: 2560, height: 1440 });
    await expect(
      qlipBrowserViewport(context as never, { width: 2560, height: 3589 }),
    ).resolves.toBeNull();
    expect(sets).toEqual([]);
  });
});
