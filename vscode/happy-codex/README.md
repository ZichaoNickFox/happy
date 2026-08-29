# Happy Codex Remote

This extension connects the official VS Code Codex extension to Happy. The
Happy daemon catalogs every local interactive Codex thread (CLI and VS Code),
backfills its history into one stable encrypted Happy session, and keeps that
same thread controllable from the Happy phone app.

## Setup

1. Install the Happy CLI.
2. Install the official `openai.chatgpt` Codex extension.
3. Open the Happy icon in the Activity Bar and choose **Login to Happy**.
4. Return to the Happy panel and choose **Enable Mobile Control**.
5. Reload VS Code, open Codex, and start or resume a thread.

No custom session path is needed on the phone. Pull to refresh the machine to
run an immediate full catalog sync; the daemon also reconciles automatically.

Authentication runs in a dedicated VS Code integrated terminal. Credentials
and authentication output are never passed through the sidebar webview.

The bridge configures the official extension's `chatgpt.cliExecutable` setting
to an explicit local proxy. It preserves the previous global setting and
restores it with **Happy Codex: Disable Mobile Control**.

Messages sent from Happy start a turn when Codex is idle and steer the current
turn while it is running. Send `/abort` from Happy to interrupt the active turn.

The proxy does not read OpenAI or Happy credentials itself. Codex authentication
stays in Codex, and Happy session encryption stays in the Happy CLI.
