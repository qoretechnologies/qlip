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
