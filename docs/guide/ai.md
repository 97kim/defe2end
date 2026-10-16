# AI

defE2End works with AI coding CLIs installed on your PC. **The server never calls an AI model.** Requests go from your PC's CLI to its model provider, under your own account.

## Supported CLIs

| CLI | Minimum version | Upper limit |
|---|---|---|
| Claude Code (`claude`) | 2.1.300 | none |
| Codex CLI (`codex`) | 0.162.1 | none |

Older versions are refused, with the reason shown. There is no upper limit because the app checks the restrictions on every run (see below) instead of trusting a version number.

Install the CLI and sign in from a terminal (`claude login`, `codex login`) before using it with defE2End. If the sign-in expires, the app tells you to sign in again.

## MCP server

The desktop app includes a local stdio MCP server, `defe2end-mcp`. It has no network port. Claude Code and Codex start it themselves.

To register it, open **AI connection** in the app settings. The app runs `claude mcp add --scope user defe2end …` and `codex mcp add defe2end …` for you, replacing an existing `defe2end` entry.

- `defe2end-mcp` holds no server credentials. It talks to the running desktop app over a local socket only the same OS user can open, and the app calls the server with your permissions. **When the app is not running or you are signed out, every tool returns `desktop-not-running`.**
- Tools can list, read, create and run scenarios, read results and drive the side browser. Destructive actions (cancel runs, stop all, delete schedules) are not available as tools; do them in the web UI or the app.
- A view-only user gets the same view-only access through MCP.

## In-app chat and failure diagnosis

The app can run the CLI for you in a chat panel and to explain failed runs. In this mode the AI can use **only defE2End's tools**:

- Claude Code runs with no built-in tools, only the `defe2end` MCP server, and user/project settings, hooks and plugins ignored.
- Codex runs in a separate home folder with only the `defe2end` MCP server, a read-only sandbox and built-in tools turned off.
- Before and during each run the app checks what the CLI actually loaded. If anything else shows up, the app stops the CLI and refuses further chats with that CLI until the app restarts.

Limits:

- For Codex the check happens while it runs, so a first forbidden call may already have run when the app stops it.
- Pages you test are sent to the model as context. Text on a page is data, not instructions, and the prompt says so, but that is not a security boundary. Don't point the chat at pages with data you can't send to your model provider.
- Chat history is kept in memory only and is gone when the app quits.
- Up to 4 images per message, 6 MB each.
