import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { BodyPortal } from './BodyPortal.js';

const meta = {
  title: 'Example/BodyPortal',
  component: BodyPortal,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof BodyPortal>;

export default meta;
type Story = StoryObj<typeof meta>;
type StoryContext = Parameters<NonNullable<Story['play']>>[0];

/**
 * The capture-time viewport reset sizes the story canvas to the viewport but
 * must leave elements portalled into <body> alone. Before the fix the
 * content-sized portal was stretched to 100% x 100% of the viewport.
 */
export const KeepsItsOwnSize: Story = {
  args: { label: 'floating actions' },
  play: async ({ canvasElement }: StoryContext) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/portalled into body/i)).toBeInTheDocument();

    const portal = document.querySelector<HTMLElement>('[data-testid="body-portal"]');
    if (!portal) throw new Error('portal not rendered');
    const rect = portal.getBoundingClientRect();
    // Content-sized: a short label, one line. Stretched: the whole viewport.
    await expect(rect.width).toBeLessThan(window.innerWidth / 2);
    await expect(rect.height).toBeLessThan(60);
    await expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);

    // The anonymous story canvas itself still fills the viewport.
    await expect(canvasElement.getBoundingClientRect().height).toBe(window.innerHeight);
  },
};
