import type { Meta, StoryObj } from '@storybook/react-vite';

import { expect, userEvent, within } from 'storybook/test';
import { screenshot } from '../browser.js';

import { Page } from './Page.js';

const meta = {
  title: 'Example/Page',
  component: Page,
  parameters: {
    // More on how to position stories at: https://storybook.js.org/docs/configure/story-layout
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;
type StoryContext = Parameters<NonNullable<Story['play']>>[0];

export const LoggedOut: Story = {};

/**
 * A desktop viewport wider and taller than the 1280×720 headless browser
 * window. `fullSizeCaptures` grows the window to hold it, so the capture is
 * 1920×1080; without it Vitest would scale the story down to 1280×720. The
 * e2e test reads the PNG.
 */
export const DesktopFullSize: Story = {
  parameters: {
    qlip: { viewport: { width: 1920, height: 1080 }, fullSizeCaptures: true },
  },
};

// More on component testing: https://storybook.js.org/docs/writing-tests/interaction-testing
export const LoggedIn: Story = {
  play: async (ctx: StoryContext) => {
    const { canvasElement } = ctx;
    const canvas = within(canvasElement);
    const loginButton = canvas.getByRole('button', { name: /Log in/i });
    await expect(loginButton).toBeInTheDocument();
    await userEvent.click(loginButton);
    await expect(loginButton).not.toBeInTheDocument();

    const logoutButton = canvas.getByRole('button', { name: /Log out/i });
    await expect(logoutButton).toBeInTheDocument();
    await screenshot(ctx, 'after-login');
  },
};

export const ElementWithFullHeight: Story = {
  render: () => {
    return (
      <div style={{ height: '100%', backgroundColor: 'lightblue' }}>
        <h1>This element should take the full height of the viewport</h1>
      </div>
    );
  },
};

export const WithConsoleError: Story = {
  render: () => {
    console.error('Test console error from story');
    return (
      <div>
        <h1>This story emits a console error</h1>
      </div>
    );
  },
};
