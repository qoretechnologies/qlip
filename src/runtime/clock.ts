/**
 * Mock-proof timing for the browser runtime.
 *
 * Consumer test suites routinely mock the clock — `mockdate` freezes
 * `Date.now()` (Storybook's common `parameters.mockdate` decorator
 * pattern), and sinon / `vi.useFakeTimers` replace `setTimeout` /
 * `setInterval` / `performance.now`. Qlip's capture pipeline runs
 * inside the same page, so its elapsed-time measurements must keep
 * working under those mocks: with a frozen `Date.now()`,
 * `waitForDomIdle` never saw time advance and waited forever — the
 * `afterEach` capture hook then hit Vitest's hook timeout for every
 * story in the file (observed with reqore's DatePicker stories, the
 * only ones using `parameters.mockdate`).
 *
 * This module snapshots the pristine implementations at module-load
 * time. Setup files are imported before any test or decorator code
 * runs, so the bindings below are taken before a mock can be
 * installed.
 */

const realPerformance =
  typeof globalThis.performance !== 'undefined' ? globalThis.performance : null;

const boundPerformanceNow =
  realPerformance && typeof realPerformance.now === 'function'
    ? realPerformance.now.bind(realPerformance)
    : null;

const boundDateNow = Date.now.bind(Date);

/**
 * Monotonic elapsed-time clock. Prefers `performance.now()` (which
 * `mockdate` does not patch and which never jumps backwards); falls
 * back to the load-time `Date.now` binding in exotic environments.
 * Only meaningful for measuring durations — not wall-clock time.
 */
export const monotonicNow: () => number = boundPerformanceNow ?? boundDateNow;

/**
 * Wall-clock timestamp from the pristine `Date.now` binding. Use for
 * data that ends up in the manifest (log timestamps, fragment ids) so
 * a frozen mock date doesn't leak into reporting.
 */
export const realDateNow: () => number = boundDateNow;

/** Pristine timer functions, immune to fake-timer installs. */
export const realSetTimeout: typeof globalThis.setTimeout =
  globalThis.setTimeout.bind(globalThis);
export const realClearTimeout: typeof globalThis.clearTimeout =
  globalThis.clearTimeout.bind(globalThis);
export const realSetInterval: typeof globalThis.setInterval =
  globalThis.setInterval.bind(globalThis);
export const realClearInterval: typeof globalThis.clearInterval =
  globalThis.clearInterval.bind(globalThis);
