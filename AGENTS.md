This private repository is the source code for **Qlip**, (`@qoretechnologies/qlip`), a specialized Storybook screenshot capture tool designed as a Vitest addon plugin for automated visual regression testing.

This UIs purpose is to provide a user-friendly interface for configuring, managing, and reviewing screenshot captures taken during Storybook test executions.

## Your role (AI agent)

You are an expert web app developer. You are responsible for implementing the project **one task at a time**.

## What We're Building

A production-ready screenshot automation tool that integrates seamlessly with the Vitest + Storybook testing workflow, providing:

**Core Capabilities:**

- **Automatic Screenshots** - Captured after every story test completes
- **Manual Screenshots** - On-demand capture via `screenshot()` function in play functions
- **Error Screenshots** - Automatic capture when tests fail (configurable per story)

**Key Features:**

- **Animation Control** - Disable or pause CSS animations before capture to ensure consistent screenshots
- **DOM Idle Waiting** - Waits for DOM mutations to settle (handles react-spring and other animation libraries)
- **Element Masking** - CSS selector-based masking with `ignoreElements` to hide dynamic content (timestamps, ads, etc.)
- **Viewport Control** - Customizable viewport sizes per story or globally
- **Intelligent Option Resolution** - Three-tier precedence (explicit options → story parameters → plugin defaults)
- **Organized Output** - Timestamped build IDs with separate directories for auto/manual/error captures
- **Comprehensive Manifest** - JSON manifest with stats, metadata, and timing for each screenshot

**Architecture:**

- `/src/plugin/` - Vitest plugin integration
- `/src/runtime/` - Screenshot capture, setup hooks, and state management
- `/src/fs/` - File system operations and output organization
- `/src/config/` - Configuration resolution logic
- `/src/types.ts` - TypeScript definitions

**Tech Stack:**

- Vitest 4.x + Playwright for browser automation
- Storybook 10.x for component documentation
- TypeScript with strict typing
- React 19.x for demo components

**Output Structure:**

```
./qlip/screenshots/<buildId>/stories/
  ├── auto/<storyTitle>--<storyName>.png
  ├── manual/<storyTitle>--<storyName>--<screenshotName>.png
  ├── error/<storyTitle>--<storyName>--qlip-auto-error-capture.png
  └── manifest.json
```

---

## Rules

- The project is split into tasks, each task lives in its own file under the `.tasks/` directory.
- Only work on the **current task**, defined as:
  - the first unchecked task in the checklist below, OR
  - the specific task the user explicitly told you to do.
- You must implement the current task fully and correctly. **Do not start the next task** until the user explicitly tells you to move on.
- A task may have been updated since you last checked it. Always re-check the task file before starting it and before moving on.
- Do not do “while I’m here” refactors. **No changes outside the task scope** unless the user approves first.
- If you think you have a better approach than the task describes, propose it to the user **before** implementing it.

## Definition of done (for every task)

When you believe the task is complete:

1. Ensure the app/build runs as described by the task.
2. Add/extend automated tests appropriate for the task.
3. Run the test suite and ensure everything passes.
4. Provide a short “done” summary: what changed, how to run it, and what tests were added.

## General quality expectations

- This is a real-world project: code quality, security, and performance matter.
- Use TypeScript with strict typing.
- Define prop interfaces for each component with `I` prefix for interfaces and `T` prefix for types.
- Prefer clear, maintainable code over cleverness.
- Follow existing code patterns for new components; refer to similar components for guidance.
- Check if a helper or utility already exists before writing a new one.
- Keep the main branch runnable: no broken builds, no failing tests.

## Dependency version policy (IMPORTANT)

- Always use the **latest stable versions** of dependencies at the time of implementation.
- Do **not** install outdated or legacy versions (e.g. React 18.x) unless:
  - the task explicitly requires it, or
  - the latest version is incompatible with another required dependency.
- Before installing or upgrading dependencies:
  - Check the current latest stable release (major/minor) of the package.
  - Prefer modern APIs and patterns introduced in the latest versions.
- If you intentionally choose **not** to use the latest version:
  - Clearly explain why in the task summary.
  - State which version was chosen and what blocks upgrading.

Installing older versions “by habit” or for convenience is not acceptable.

## Testing

- IMPORTANT: Do not write trivial or self-asserting tests. Tests must call real production code and assert on actual behavior. If removing/breaking the implementation does not cause the test to fail, the test is invalid and must be rewritten.
- Run tests after changes.
- Run `yarn precheck` after completing a task (if available in this repo).
- Storybook expectations:
  - UI components must have stories.
  - If interaction behavior exists, add Storybook `play` tests where appropriate.
  - Storybook-related testing has higher priority than unit tests for UI-only changes.

## Tasks overview (high-level only)

This file does **not** contain the detailed task list. Only the high-level outline is described here. When a task is done, check it off below.

1.  [x] Setup - Initial project setup with Vite, Vitest and TypeScript. See .tasks/SETUP.md
