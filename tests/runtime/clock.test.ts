import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  monotonicNow,
  realClearInterval,
  realDateNow,
  realSetInterval,
  realSetTimeout,
} from '../../src/runtime/clock.js';

/**
 * Regression coverage for the frozen-clock hang: consumer stories that
 * mock the date (e.g. Storybook's `parameters.mockdate` pattern, which
 * calls `MockDate.set()` in a decorator) freeze `Date.now()`. Qlip's
 * idle-wait measured elapsed time with `Date.now()` and spun forever,
 * timing out the afterEach capture hook for every story in the file.
 * The clock module snapshots pristine implementations at load time so
 * later mocks can't affect it.
 */
describe('runtime clock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('monotonicNow advances while Date.now is frozen (mockdate scenario)', async () => {
    const frozen = new Date('2024-04-10T08:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(frozen);

    const start = monotonicNow();
    await new Promise((resolve) => realSetTimeout(resolve, 25));
    const elapsed = monotonicNow() - start;

    expect(Date.now()).toBe(frozen);
    expect(elapsed).toBeGreaterThan(0);
  });

  it('realDateNow ignores a Date.now mock', () => {
    const frozen = 12345;
    vi.spyOn(Date, 'now').mockReturnValue(frozen);

    expect(Date.now()).toBe(frozen);
    expect(realDateNow()).not.toBe(frozen);
    expect(realDateNow()).toBeGreaterThan(1_000_000_000_000);
  });

  it('real timers keep firing under vi.useFakeTimers', async () => {
    vi.useFakeTimers();

    let ticks = 0;
    const interval = realSetInterval(() => {
      ticks += 1;
    }, 5);

    // Wait on a pristine timeout — the faked global setTimeout would
    // never fire without a manual vi.advanceTimersByTime.
    await new Promise((resolve) => realSetTimeout(resolve, 40));
    realClearInterval(interval);

    expect(ticks).toBeGreaterThan(0);
  });
});
