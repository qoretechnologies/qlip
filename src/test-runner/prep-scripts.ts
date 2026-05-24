/**
 * Browser-side prep functions for the test-runner capture path,
 * passed to Playwright's `page.evaluate()`.
 *
 * These are the same stability mechanics qlip's Vitest plugin
 * path uses in `src/runtime/screenshot.ts`, ported to standalone
 * functions that Playwright can serialize and execute inside the
 * page context.
 *
 * IMPORTANT: each function must be **closure-free** — it can
 * reference only its declared arguments and globals (document,
 * window, MutationObserver). Playwright serializes the function
 * source to a string and re-evaluates it inside the page, so any
 * captured closure variables would be lost.
 *
 * Each function returns a value to the Node side (success
 * indicator, mask handle, etc.) so the caller can chain cleanup.
 */

/**
 * Disable or pause CSS animations + transitions before screenshot.
 * Mirrors `applyAnimationControl` in `src/runtime/screenshot.ts`.
 *
 * - `disableAnimations: true` finishes any in-flight animations
 *   and prevents new ones starting (style rule + getAnimations().finish())
 * - `pauseAnimationsAtEnd: true` pauses any running animations
 *   in place (style rule + getAnimations().pause())
 *
 * If both flags are false, removes any qlip animation control
 * style previously injected.
 */
export const applyAnimationControlInPage = (opts: {
  disableAnimations: boolean;
  pauseAnimationsAtEnd: boolean;
}): void => {
  const { disableAnimations, pauseAnimationsAtEnd } = opts;
  const styleId = '__qlip-animation-control';
  const doc = document;
  const existing = doc.getElementById(styleId);

  if (!disableAnimations && !pauseAnimationsAtEnd) {
    if (existing) existing.remove();
    return;
  }

  const style = existing ?? doc.createElement('style');
  style.id = styleId;
  if (disableAnimations) {
    style.textContent = [
      '*, *::before, *::after {',
      '  animation: none !important;',
      '  transition: none !important;',
      '  scroll-behavior: auto !important;',
      '}',
    ].join('\n');
  } else {
    style.textContent = [
      '*, *::before, *::after {',
      '  animation-play-state: paused !important;',
      '  transition-duration: 0s !important;',
      '  transition-delay: 0s !important;',
      '}',
    ].join('\n');
  }
  if (!existing) doc.head.appendChild(style);

  if (typeof doc.getAnimations === 'function') {
    const animations = doc.getAnimations();
    for (const animation of animations) {
      if (disableAnimations && typeof animation.finish === 'function') {
        try {
          animation.finish();
        } catch {
          /* finish() can throw on already-completed animations */
        }
      } else if (
        pauseAnimationsAtEnd &&
        typeof animation.pause === 'function'
      ) {
        animation.pause();
      }
    }
  }
};

/**
 * Wait for the DOM to be "idle" (no mutations for `idleMs` ms).
 * Returns when idle, or when `maxWaitMs` elapses, whichever comes
 * first. Mirrors `waitForDomIdle` in `src/runtime/screenshot.ts`.
 *
 * Returned as a thenable; the caller awaits in `page.evaluate()`.
 */
export const waitForDomIdleInPage = (opts: {
  idleMs: number;
  maxWaitMs: number;
}): Promise<void> => {
  return new Promise<void>((resolve) => {
    const { idleMs, maxWaitMs } = opts;
    if (idleMs <= 0) {
      resolve();
      return;
    }

    const doc = document;
    if (!doc || typeof MutationObserver === 'undefined') {
      setTimeout(resolve, idleMs);
      return;
    }

    const start = Date.now();
    const resolvedMaxWait = Math.max(idleMs, maxWaitMs);
    let lastChange = Date.now();
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(checkInterval);
      resolve();
    };

    const observer = new MutationObserver(() => {
      lastChange = Date.now();
    });

    observer.observe(doc.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    const checkInterval = setInterval(
      () => {
        const now = Date.now();
        if (now - lastChange >= idleMs || now - start >= resolvedMaxWait) {
          finish();
        }
      },
      Math.min(50, idleMs),
    );
  });
};

/**
 * Apply opaque masks over elements matching the given CSS selectors,
 * so they don't appear in screenshots (timestamps, ads, etc.).
 * Mirrors `applyIgnoreMasks` in `src/runtime/screenshot.ts`.
 *
 * Returns an array of mask element IDs so a follow-up call to
 * `removeIgnoreMasksInPage(ids)` can clean them up after the
 * screenshot is taken.
 */
export const applyIgnoreMasksInPage = (opts: {
  selectors: string[];
}): string[] => {
  const { selectors } = opts;
  const doc = document;
  if (!doc || selectors.length === 0) return [];

  const ids: string[] = [];
  let counter = 0;
  for (const selector of selectors) {
    const nodes = Array.from(
      doc.querySelectorAll<HTMLElement>(selector),
    );
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      counter += 1;
      const maskId = `__qlip-mask-${String(Date.now())}-${String(counter)}`;
      const mask = doc.createElement('div');
      mask.id = maskId;
      mask.setAttribute('data-qlip-mask', selector);
      mask.style.position = 'fixed';
      mask.style.left = `${String(rect.left)}px`;
      mask.style.top = `${String(rect.top)}px`;
      mask.style.width = `${String(rect.width)}px`;
      mask.style.height = `${String(rect.height)}px`;
      mask.style.background = '#000';
      mask.style.pointerEvents = 'none';
      mask.style.zIndex = '2147483647';
      doc.body.appendChild(mask);
      ids.push(maskId);
    }
  }
  return ids;
};

/**
 * Remove masks created by `applyIgnoreMasksInPage`.
 */
export const removeIgnoreMasksInPage = (opts: { ids: string[] }): void => {
  const { ids } = opts;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
};
