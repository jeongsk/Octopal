# Octopal

Tauri 2 desktop app: a local-first multi-agent workspace built on top of the Claude CLI. macOS + Windows. Free, MIT.

## Stack

Tauri 2 (Rust) + React 18 + TypeScript 5.6 + Vite 5. Package manager: **pnpm** (`pnpm@10.8.1`). Tests: Vitest + jsdom + @testing-library/react.

**Hard runtime dependency:** the user's machine must have the Claude CLI installed and logged in. The app shows a login modal on startup if missing.

## Commands

```
pnpm dev            # Tauri dev (Vite + cargo watch); uses src-tauri/tauri.dev.conf.json
pnpm dev:renderer   # Frontend only on :5173 (no Rust)
pnpm build          # Production build via scripts/tauri-build.mjs
pnpm build:signed   # cargo tauri build (signed release)
pnpm test           # vitest run
pnpm test:watch     # vitest watch
pnpm test:coverage  # vitest with coverage
```

## Layout

```
renderer/        React/Vite frontend. Entry: renderer/src/main.tsx. Root: renderer/src/App.tsx.
  src/components/  ChatPanel, LeftSidebar, RightSidebar, WikiPanel, ActivityPanel, SettingsPanel, TaskBoard, modals
  src/i18n/        en + ko translations
src-tauri/       Rust backend.
  src/commands/    IPC handlers (one .rs per domain)
  src/main.rs      App lifecycle, window setup
  src/lib.rs       Plugin & command registration
  src/state.rs     Shared app state
scripts/         Build helpers (tauri-build.mjs)
assets/          Logo, fonts, icons
.context/        Per-workspace agent scratchpad (gitignored)
```

## Frontend architecture

- **3-panel layout**: `LeftSidebar.tsx` / center tabs (`ChatPanel`, `WikiPanel`, `ActivityPanel`, `SettingsPanel`, `TaskBoard`) / `RightSidebar.tsx`.
- **State lives in `App.tsx`** via plain `useState`. **No Redux/Zustand.** Tauri IPC is called directly via `@tauri-apps/api`.
- **Agent locks**: `App.tsx` keeps a per-agent FIFO queue (`agentLocksRef`) to serialize Claude CLI invocations for the same agent.

## Backend architecture

Key modules in `src-tauri/src/commands/`:

| File | Role |
|---|---|
| `agent.rs` | Agent lifecycle (create/edit/delete/invoke; spawns Claude CLI) |
| `claude_cli.rs` | Spawn + stream Claude CLI subprocess |
| `dispatcher.rs` | Message routing / which agents to invoke |
| `octo.rs` | Read/write agent config files under `octopal-agents/` |
| `folder.rs` | Folder management within a workspace |
| `process_pool.rs` | **Persistent** Claude CLI process pool — sessions survive across messages |
| `model_probe.rs` | Adaptive Claude model detection (incl. Opus availability) |
| `file_lock.rs` | Prevents concurrent writes |
| `files.rs`, `wiki.rs`, `workspace.rs`, `settings.rs`, `backup.rs` | CRUD for those domains |

File watching uses the `notify` crate, scoped to `octopal-agents/`.

## Landmines

- **Only scan `octopal-agents/` for agent configs — never the project root.** Scanning root caused the phantom-agent bug (commit `dbcc6e6`).
- **Do not reintroduce `tauri-plugin-fs`.** It was removed in `df062c7` to stop macOS permission popups; use raw `std::fs` ops.
- **`.octo` files are legacy.** Agents have lived in folder form under `octopal-agents/{name}/` since v0.1.31. Don't write `.octo` files.
- **Process pool cleanup matters.** Long-lived Claude CLI processes must be torn down on app exit (handled in state teardown — keep it that way).
- `octopal-agents/`, `.octopal/`, `*.octo` are **gitignored** — local per-clone state, never commit.

## Data paths (user machine)

```
~/.octopal-dev/state.json   # dev mode
~/.octopal/state.json       # prod
~/.octopal/room-log.json    # chat history
~/.octopal/uploads/         # attachments
~/.octopal/wiki/<workspaceId>/
```

## Skills

Spawned Claude CLI processes auto-discover skills from:

- **Workspace** `<workspace>/.claude/skills/<name>/SKILL.md` — visible to every agent (cwd is the workspace folder).
- **Per-agent** `<workspace>/octopal-agents/<agent>/.claude/skills/<name>/SKILL.md` — visible only to that agent. Wired via `--add-dir <agent_dir>` in `agent.rs`.

The dispatcher process (cwd `.`) is intentionally left out — it routes messages and shouldn't load skills. Live edits to existing `.claude/skills/` directories are picked up without restart, but creating a brand-new skills directory after the agent has spawned requires the next message to restart that agent's pooled process (the Claude CLI watcher only registers directories that existed at session start).

## Notes

- Global behavioral rules (simplicity, surgical changes, Podman, no Google Fonts, etc.) live in `~/.claude/CLAUDE.md` and are not duplicated here.
