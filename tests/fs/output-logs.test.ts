import { describe, expect, it } from 'vitest';
import {
  AUTO_ERROR_SCREENSHOT_BASE,
  buildAutoLogPath,
  buildManualLogPath,
} from '../../src/fs/output.js';

describe('log path helpers', () => {
  it('builds auto log paths', () => {
    const pathInfo = buildAutoLogPath({
      buildDir: '/tmp/qlip/20250102-030405',
      storyId: 'example--page',
      storyTitle: 'Example/Page',
      storyName: 'Logged In',
    });

    expect(pathInfo.relativePath).toBe(
      'logs/auto/Example_Page--Logged_In.json',
    );
    expect(pathInfo.absolutePath).toBe(
      '/tmp/qlip/20250102-030405/logs/auto/Example_Page--Logged_In.json',
    );
  });

  it('builds manual log paths', () => {
    const pathInfo = buildManualLogPath({
      buildDir: '/tmp/qlip/20250102-030405',
      storyId: 'example--page',
      storyTitle: 'Example/Page',
      storyName: 'Logged In',
      screenshotName: 'after-login',
    });

    expect(pathInfo.relativePath).toBe(
      'logs/manual/Example_Page--Logged_In--after-login.json',
    );
    expect(pathInfo.absolutePath).toBe(
      '/tmp/qlip/20250102-030405/logs/manual/Example_Page--Logged_In--after-login.json',
    );
  });

  it('routes error logs to the error folder', () => {
    const pathInfo = buildManualLogPath({
      buildDir: '/tmp/qlip/20250102-030405',
      storyId: 'example-button--primary',
      screenshotName: AUTO_ERROR_SCREENSHOT_BASE,
    });

    expect(pathInfo.relativePath).toBe(
      `logs/error/example-button--primary--${AUTO_ERROR_SCREENSHOT_BASE}.json`,
    );
    expect(pathInfo.absolutePath).toBe(
      `/tmp/qlip/20250102-030405/logs/error/example-button--primary--${AUTO_ERROR_SCREENSHOT_BASE}.json`,
    );
  });
});
