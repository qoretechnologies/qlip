import { QlipConsoleLevel, QlipParameters, QlipResolvedDefaults, QlipScreenshotOptions } from '../types.js';

export interface QlipResolvedOptions {
  skip: boolean;
  viewport: { width: number; height: number };
  disableAnimations: boolean;
  pauseAnimationsAtEnd: boolean;
  waitForIdleMs: number;
  maxWaitForIdleMs: number;
  ignoreElements: string[];
  auto: boolean;
  manual: boolean;
  error: boolean;
  captureConsole: boolean;
  captureConsoleLevels: QlipConsoleLevel[];
  maxConsoleLogs: number;
}

export const resolveQlipOptions = ({
  defaults,
  story,
  override,
}: {
  defaults: QlipResolvedDefaults;
  story?: QlipParameters;
  override?: QlipScreenshotOptions;
}): QlipResolvedOptions => {
  return {
    skip: override?.skip ?? story?.skip ?? defaults.skip,
    viewport: override?.viewport ?? story?.viewport ?? defaults.viewport,
    disableAnimations:
      override?.disableAnimations ??
      story?.disableAnimations ??
      defaults.disableAnimations,
    pauseAnimationsAtEnd:
      override?.pauseAnimationsAtEnd ??
      story?.pauseAnimationsAtEnd ??
      defaults.pauseAnimationsAtEnd,
    waitForIdleMs:
      override?.waitForIdleMs ??
      story?.waitForIdleMs ??
      defaults.waitForIdleMs,
    maxWaitForIdleMs:
      override?.maxWaitForIdleMs ??
      story?.maxWaitForIdleMs ??
      defaults.maxWaitForIdleMs,
    ignoreElements:
      override?.ignoreElements ??
      story?.ignoreElements ??
      defaults.ignoreElements,
    auto: override?.auto ?? story?.auto ?? defaults.auto,
    manual: override?.manual ?? story?.manual ?? defaults.manual,
    error: override?.error ?? story?.error ?? defaults.error,
    captureConsole:
      override?.captureConsole ??
      story?.captureConsole ??
      defaults.captureConsole,
    captureConsoleLevels:
      override?.captureConsoleLevels ??
      story?.captureConsoleLevels ??
      defaults.captureConsoleLevels,
    maxConsoleLogs:
      override?.maxConsoleLogs ??
      story?.maxConsoleLogs ??
      defaults.maxConsoleLogs,
  };
};
