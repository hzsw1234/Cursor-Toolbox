# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Cursor Toolbox is a Chrome/Edge Manifest V3 browser extension that enhances the cursor.com web chat experience with MCP tool bridging, session management, and layout enhancements. There is no backend server or database — all state lives in `chrome.storage.local`.

### Dependencies

The only Node.js dependency directory is `web_mcp_cli/`. Run `pnpm install` there (lockfile: `pnpm-lock.yaml`, package manager: pnpm 10.30.3).

### Build

Bundle the background service worker (the only build step for development):

```
pnpm --dir web_mcp_cli exec esbuild background.js --bundle --format=esm --platform=browser --target=chrome120 --outfile=background.bundle.js --sourcemap
```

For watch mode during development:

```
pnpm --dir web_mcp_cli exec esbuild background.js --bundle --format=esm --platform=browser --target=chrome120 --outfile=background.bundle.js --sourcemap --watch
```

### Lint / Tests

There is no ESLint config, no TypeScript, and no automated test suite (`npm test` is a placeholder that exits 1). Linting and test commands are not applicable for this repo.

### Loading the extension

1. Open Chrome → `chrome://extensions` → enable Developer mode
2. Click "Load unpacked" → select the repo root `/workspace`
3. The extension appears as "Cursor Toolbox 1.1.2"

### Caveats

- The full release build script (`scripts/build-extension.ps1`) is PowerShell and targets Windows. On Linux, use the esbuild command above directly.
- Content scripts only inject on `https://cursor.com/*`, so full end-to-end MCP testing requires a cursor.com session and a running MCP server.
- The generated `web_mcp_cli/background.bundle.js` is gitignored — it must be rebuilt after cloning or pulling.
