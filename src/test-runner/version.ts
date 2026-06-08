/**
 * Build-time version constant for the test-runner library.
 *
 * Hardcoded instead of reading `package.json` via fs at runtime
 * because:
 *   - `import.meta.url` (the ESM way to locate the module file)
 *     isn't available in CJS, and we ship both
 *   - `require.resolve('@qoretechnologies/qlip/package.json')` would
 *     work in CJS but breaks in ESM without `createRequire`
 *   - It's only used for the `manifest.tool.version` field — purely
 *     informational
 *
 * TODO: add a `prebuild` script that overwrites this from the root
 * package.json so versions stay in sync automatically. For now,
 * keep manually in sync with package.json on each release.
 */
export const QLIP_TOOL_VERSION = '0.1.0';
