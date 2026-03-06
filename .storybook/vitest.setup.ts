import * as a11yAddonAnnotations from "@storybook/addon-a11y/preview";
import { setProjectAnnotations } from '@storybook/react-vite';
import * as projectAnnotations from './preview';

// This is an important step to apply the right configuration when testing your stories.
// More info at: https://storybook.js.org/docs/api/portable-stories/portable-stories-vitest#setprojectannotations
setProjectAnnotations([a11yAddonAnnotations, projectAnnotations]);

// Ensure components rendered in Vitest browser mode have full viewport dimensions.
// Storybook's portable stories create a plain <div> as canvasElement appended to <body>,
// so we need html, body, and that container div to all have full height.
const style = document.createElement('style');
style.textContent = `html, body, body > div, #storybook-root { width: 100%; height: 100%; margin: 0; padding: 0; }`;
document.head.appendChild(style);