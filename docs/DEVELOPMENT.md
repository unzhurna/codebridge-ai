# Development Guide

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## VS Code extension

```bash
pnpm --filter codebridge-vscode build
```

Open the repository in VS Code and press F5 to launch the Extension Development Host.

## Chrome extension

```bash
pnpm --filter codebridge-chrome build
```

Load `apps/chrome-extension/dist` from `chrome://extensions` using Load unpacked.

## Development order

1. Start pairing from the Extension Development Host.
2. Enter the code in the Chrome popup.
3. Confirm the popup reports Connected.
4. Restart either side and verify reconnect behavior.


## v0.9.0 agent persistence and approved writes

Agent sessions are stored in VS Code extension `globalState`. Writes are limited to `workspace.write_file` and require a native VS Code modal after opening a diff. No terminal execution is enabled.
