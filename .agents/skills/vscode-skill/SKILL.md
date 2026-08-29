---
name: vscode-skill
description: Build, debug, package, or review the Happy VS Code Codex bridge that intercepts the official openai.chatgpt app-server executable, mirrors VS Code Codex threads into encrypted Happy sessions, and lets the Happy phone app send messages, steer turns, or abort the same Codex session. Use for changes under vscode/happy-codex, the happy vscode-codex-proxy CLI command, VS Code-to-phone Codex session sync, bridge installation/restoration, or related app-server JSON-RPC tests.
---

# Happy VS Code Codex Bridge

## Preserve the product contract

Make the official VS Code Codex thread the source of truth. Synchronize that
same thread to Happy; do not launch a separate `happy codex` terminal session.

Keep this flow intact:

```text
official openai.chatgpt extension
  -> chatgpt.cliExecutable
  -> generated Happy wrapper
  -> happy-vscode-codex (direct long-running bin)
  -> internal vscode-codex-proxy command
  -> bundled official codex app-server

Happy phone app
  <-> encrypted Happy session
  <-> proxy JSON-RPC injection/mirroring
  <-> the same Codex threadId used by VS Code
```

Implement these behaviors:

- Create one Happy session for each observed Codex `threadId`.
- Mirror VS Code user turns and final Codex events to the phone.
- Send a phone message with `turn/start` when the thread is idle.
- Send a phone message with `turn/steer` when a turn is active.
- Map the exact phone text `/abort` to `turn/interrupt`.
- Keep all unrelated JSON-RPC requests, responses, notifications, and
  server-initiated approval requests byte-semantically transparent to the
  official extension.
- Swallow responses only for proxy-injected request IDs. Never expose those
  IDs to VS Code.
- Degrade to ordinary local Codex if Happy authentication or networking fails.
  Never break the VS Code-to-Codex transport because cloud sync failed.

## Work in the canonical locations

- VS Code extension: `vscode/happy-codex/`
- Extension host entry: `vscode/happy-codex/src/extension.js`
- Activity Bar login/control view: `happyCodex.controlCenter`
- Wrapper/config helpers: `vscode/happy-codex/src/bridgeConfig.js`
- Proxy process: `packages/happy-cli/src/codex/vscodeCodexProxy.ts`
- Testable multiplexer: `packages/happy-cli/src/codex/vscodeCodexProxyCore.ts`
- Direct proxy bin: `packages/happy-cli/bin/happy-vscode-codex.mjs`
- CLI dispatch: `packages/happy-cli/src/index.ts`

Keep protocol decisions in the testable proxy core. Keep VS Code APIs out of
`bridgeConfig.js` so Node tests can run without an Extension Host.

## Treat interception as an explicit reversible operation

Require the user to run **Happy Codex: Enable Mobile Control**. On enable:

1. Require the official `openai.chatgpt` extension.
2. Verify `happy auth status` before changing configuration.
3. Resolve the Codex executable bundled with the installed official extension.
4. Generate a wrapper in this extension's `globalStorageUri`.
5. Save the previous global `chatgpt.cliExecutable` value.
6. Set the global value to the wrapper and request a window reload.

On disable, restore the exact previous global value, or remove the override if
none existed, then request a reload. Do not patch official extension files,
read its webview DOM, scrape tokens, or modify Codex storage.

## Respect security and compatibility boundaries

- Keep Codex authentication inside the official Codex binary.
- Keep Happy credentials and encryption inside `happy-cli`.
- Pass arguments as arrays or through the generated quoted wrapper. Do not use
  shell interpolation from workspace content or message content.
- Invoke `happy-vscode-codex` directly from the wrapper. Do not run this
  long-lived proxy through `bin/happy.mjs`, whose synchronous re-exec boundary
  prevents reliable signal forwarding to Codex.
- Write wrapper files with user-only executable permissions on POSIX.
- Key routing by `threadId`; do not assume one app-server process owns only one
  thread.
- Ignore streaming agent deltas when also mirroring the final `agentMessage`,
  preventing duplicate answers on the phone.
- Prefer the last VS Code `turn/start` parameters when constructing later
  phone-originated turns so model, cwd, sandbox, and approval choices persist.
- Add protocol support from generated bindings for the installed Codex CLI:
  `codex app-server generate-ts --out <temporary-directory>`.
- Do not rely on undocumented exports from `openai.chatgpt`; its activation API
  does not expose live thread objects.

## Register and dispose VS Code resources

Register commands, configuration listeners, output channels, and status bar
items in `activate(context)`. Push every disposable into
`context.subscriptions`. Keep activation events limited to startup status and
the contributed commands.

Use global configuration for `chatgpt.cliExecutable`, because the official
setting is application-scoped. Surface failures through actionable VS Code
messages and log paths only to the `Happy Codex` output channel.

Provide a Happy Activity Bar container with a `happyCodex.controlCenter`
webview. Show Happy authentication and bridge status, plus actions to log in,
enable or disable mobile control, open Codex, and refresh. Launch `happy auth
login` as the executable of a dedicated integrated terminal with argument
arrays; never interpolate the configured executable into a shell command.
Keep credentials and raw authentication output outside the webview. Refresh
the panel after commands, configuration changes, and periodically while the
view is open.

## Validate every change

Run from the repository root:

```bash
pnpm --filter happy exec vitest run src/codex/vscodeCodexProxyCore.test.ts
pnpm --filter happy typecheck
npm --prefix vscode/happy-codex run check
npm --prefix vscode/happy-codex run package
```

Also validate the skill after editing it:

```bash
python3 /Users/liuzichao/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/vscode-skill
```

Before delivery, inspect the VSIX with `unzip -l` and confirm it contains the
extension sources, manifest, license, and README while excluding tests and
development caches. Audit touched text files as UTF-8 without BOM.

For a manual smoke test:

1. Install the VSIX and open the Happy Activity Bar view.
2. Start login from the view, complete it in the integrated terminal, and
   refresh until the view reports authenticated.
3. Enable mobile control from the view and reload VS Code.
4. Open Codex and send a prompt in VS Code.
5. Confirm the Happy phone app shows the same thread output.
6. Send a phone follow-up while idle and while Codex is running.
7. Send `/abort` during a turn and confirm VS Code reports interruption.
8. Disable mobile control, reload, and confirm the old
   `chatgpt.cliExecutable` setting is restored.
