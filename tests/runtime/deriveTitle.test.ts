import { describe, expect, it } from 'vitest';
import { deriveTitleNameFromStoryId } from '../../src/runtime/screenshot.js';

/**
 * A storyId is a lossy kebab of the title: it can't tell a title-path `/`
 * from a space inside a multi-word leaf. The pure derivation therefore
 * collapses "Automation Intelligence Panel" to "Automation/Intelligence/
 * Panel". When the real (CSF-meta) component name is known, we splice it
 * back in to recover the spaces.
 */
describe('deriveTitleNameFromStoryId', () => {
  const id = 'components-interfaces-shared-automation-intelligence-panel--default';

  it('collapses a multi-word leaf to slashes without the component name (documented loss)', () => {
    const { title } = deriveTitleNameFromStoryId(id);
    expect(title).toBe('Components/Interfaces/Shared/Automation/Intelligence/Panel');
  });

  it('recovers the multi-word leaf from the intact component name', () => {
    const { title } = deriveTitleNameFromStoryId(id, 'Automation Intelligence Panel');
    expect(title).toBe('Components/Interfaces/Shared/Automation Intelligence Panel');
  });

  it('handles a component that IS the whole title (no path prefix)', () => {
    const { title } = deriveTitleNameFromStoryId(
      'automation-intelligence-panel--default',
      'Automation Intelligence Panel',
    );
    expect(title).toBe('Automation Intelligence Panel');
  });

  it('leaves the title unchanged when the component name does not match the leaf', () => {
    // e.g. a PascalCase CSF name that kebabs differently than the id's tail.
    const { title } = deriveTitleNameFromStoryId(id, 'SomethingElse');
    expect(title).toBe('Components/Interfaces/Shared/Automation/Intelligence/Panel');
  });

  it('parses the story name from the id as before', () => {
    const { name } = deriveTitleNameFromStoryId(`${id}`, 'Automation Intelligence Panel');
    expect(name).toBe('Default');
  });
});
