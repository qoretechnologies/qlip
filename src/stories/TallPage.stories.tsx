import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { FixedBoxPage, TallPage } from './TallPage.js';

const meta = {
  title: 'Example/TallPage',
  component: TallPage,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof TallPage>;

export default meta;
type Story = StoryObj<typeof meta>;
type StoryContext = Parameters<NonNullable<Story['play']>>[0];

const PHONE = { width: 390, height: 844 };

/** The precondition that makes the two captures below differ: at the pinned
 *  viewport the column really scrolls, and the document does not. */
const expectsAnInnerScroller = async ({ canvasElement }: StoryContext) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText('Section 1')).toBeInTheDocument();
  const column = canvasElement.querySelector<HTMLElement>('[data-testid="tall-page-scroll"]');
  if (!column) throw new Error('column not rendered');
  await expect(column.scrollHeight).toBeGreaterThan(column.clientHeight);
  await expect(document.documentElement.scrollHeight).toBe(window.innerHeight);
};

/**
 * `fullPage`: qlip grows the viewport (and, under Vitest browser mode, the
 * browser window behind it) until the column no longer scrolls, so the
 * capture is the whole column at 1:1 — the e2e test reads the PNG's height.
 * The manifest keeps the pinned viewport as the baseline key.
 */
export const ScrollsAnInnerBox: Story = {
  parameters: {
    qlip: { viewport: PHONE, fullPage: true },
  },
  play: expectsAnInnerScroller,
};

/** The same page without `fullPage`: one screen, the rest scrolled away. */
export const OneScreen: Story = {
  parameters: {
    qlip: { viewport: PHONE },
  },
  play: expectsAnInnerScroller,
};

/**
 * `fullPage` on an ordinary page whose only scroller is a fixed-height box:
 * more viewport never reveals it, so qlip gives the growth back and the
 * capture stays one screen — not a screen of page over a tall blank strip.
 * The e2e test reads the PNG's height.
 */
export const FixedHeightBox: Story = {
  render: () => <FixedBoxPage />,
  parameters: {
    qlip: { viewport: PHONE, fullPage: true },
  },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>('[data-testid="fixed-box"]');
    if (!box) throw new Error('box not rendered');
    await expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  },
};
