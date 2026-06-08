import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { AnimatedBox } from './AnimatedBox.js';
import type { QlipParameters } from '../types.js';

const meta = {
  title: 'Example/Capture on Test Failure',
  component: AnimatedBox,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof AnimatedBox>;

export default meta;
type Story = StoryObj<typeof meta>;
type StoryContext = Parameters<NonNullable<Story['play']>>[0];

export const CaptureOnTestFailure: Story = {
  parameters: {
    qlip: {
      captureOnError: true,
      // Skipped by default so the deliberately-failing play function
      // doesn't break CI. End-to-end was validated against a local
      // qlip-server on 2026-05-24 (PROGRESS.md decision log entry
      // "Error-capture end-to-end"). To re-test: set skip=false +
      // run `QLIP_UPLOAD_URL=http://localhost:3100 yarn vitest run
      // --project storybook src/stories/FailOnPurpose.stories.ts`.
      skip: true,
    },
  },
  play: async (ctx: StoryContext) => {
    // Check if this story should be skipped (to prevent CI failures)
    // The skip parameter prevents screenshot capture, but we also need to skip the test
    const qlipParams = ctx.parameters?.qlip as QlipParameters | undefined;
    if (qlipParams?.skip) {
      console.log('FailOnPurpose test skipped - set qlip.skip to false to test error screenshots');
      return;
    }

    const canvas = within(ctx.canvasElement);

    // This will intentionally fail - clicking a non-existent button
    // An error screenshot will be captured due to captureOnError: true
    await userEvent.click(
      canvas.getByRole('button', { name: /missingButton/i }),
    );
  },
};
