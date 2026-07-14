import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import { qlipVitestPlugin } from '../../src/plugin/vitestPlugin.js';

const testRoots: string[] = [];

const resolvePluginConfig = async (test: Record<string, unknown>) => {
  const root = await mkdtemp(path.join(tmpdir(), 'qlip-plugin-config-'));
  testRoots.push(root);
  return resolveConfig(
    {
      root,
      plugins: [qlipVitestPlugin({ outputDir: path.join(root, 'output') })],
      test,
    } as Parameters<typeof resolveConfig>[0],
    'serve',
  ) as Promise<
    Awaited<ReturnType<typeof resolveConfig>> & {
      test: Record<string, unknown>;
    }
  >;
};

afterEach(async () => {
  await Promise.all(
    testRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('qlipVitestPlugin configuration merge', () => {
  it.each([
    ['one string', 'consumer-setup.ts'],
    ['multiple values', ['consumer-setup.ts', 'second-setup.ts']],
  ])('preserves %s setup files exactly once', async (_label, setupFiles) => {
    const config = await resolvePluginConfig({ setupFiles });
    const resolved = config.test.setupFiles as string[];

    expect(
      resolved.filter((file) => file === 'consumer-setup.ts'),
    ).toHaveLength(1);
    if (Array.isArray(setupFiles)) {
      expect(
        resolved.filter((file) => file === 'second-setup.ts'),
      ).toHaveLength(1);
    }
    expect(
      resolved.filter((file) => file.endsWith('/runtime/setup.ts')),
    ).toHaveLength(1);
  });

  it('preserves consumer global setup exactly once', async () => {
    const config = await resolvePluginConfig({
      globalSetup: ['consumer-global.ts'],
    });
    const resolved = config.test.globalSetup as string[];

    expect(
      resolved.filter((file) => file === 'consumer-global.ts'),
    ).toHaveLength(1);
    expect(
      resolved.filter((file) => file.endsWith('/runtime/global-setup.ts')),
    ).toHaveLength(1);
  });

  it.each([
    ['string', 'verbose'],
    ['tuple', [['json', { outputFile: 'results.json' }]]],
    ['instance', [{ onFinished: () => undefined }]],
  ])(
    'preserves a consumer %s reporter exactly once',
    async (_label, reporters) => {
      const config = await resolvePluginConfig({ reporters });
      const resolved = config.test.reporters as unknown[];

      expect(
        resolved.filter(
          (reporter) => reporter === reporters || reporter === reporters[0],
        ),
      ).toHaveLength(1);
      expect(
        resolved.filter(
          (reporter) => reporter?.constructor?.name === 'QlipUploadReporter',
        ),
      ).toHaveLength(1);
    },
  );

  it('keeps Vitest default output when no consumer reporter is configured', async () => {
    const config = await resolvePluginConfig({});
    const resolved = config.test.reporters as unknown[];

    expect(resolved.filter((reporter) => reporter === 'default')).toHaveLength(
      1,
    );
    expect(
      resolved.filter(
        (reporter) => reporter?.constructor?.name === 'QlipUploadReporter',
      ),
    ).toHaveLength(1);
  });
});
