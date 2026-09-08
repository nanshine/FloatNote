# src-tauri/src — Rust backend

Tauri 2 backend. `lib.rs` wires modules, the managed `AppState`, the invoke
handler, tray, global shortcuts, window/shortcuts setup. `main.rs` is a thin
entry that calls `floatnote::run()`.

## Module map

- `state.rs` — the `AppState` root (managed state shared by all commands,
  the in-process agent, popup, selection monitor). Constructed in
  `lib.rs::run` via `app.manage`.
- `commands.rs` + `commands/` — Tauri `#[tauri::command]` adapter layer.
  Domain modules currently cover agent, chat, and settings; add siblings rather
  than growing the root file. File logic stays in `notes`/`project`/`versions`.
- `agent/` — Rig 0.42 adapter, provider-neutral events and sessions, constrained
  flat virtual-workspace reads, Skills, mutation review state, one-use leases,
  stale checks, and atomic commit.
  Model-visible creation is `create_piece`/`create`; `write` may only review a
  rewrite of an existing note.
  The Agent runs inside the Tauri process; Node is not shipped in app bundles.
- `notes.rs` — note file read/write, `rename_note`/`delete_note`/`create_note`
  (atomic write, mtime), image path safety, project-space listing.
- `project.rs` — project-space discovery, pieces, `sanitize_folder_name`.
- `versions.rs` — snapshot/restore/purge per-note version history.
- `chat_history.rs` — `ChatHistoryStore` (~/.floatnote/chat-history).
- `paths.rs` — `user_home_dir()` / `floatnote_home()` (cross-platform).
- `watcher.rs` — `notify` file watcher + self-write suppress list
  (`mark_self_write` BEFORE writes to avoid TOCTOU; uses `into_inner()` to
  survive mutex poisoning).
- `source.rs` — macOS app-icon + browser source attribution (macOS-only).
- `capture.rs`, `cursor.rs` — external-process-only AX-first selection capture,
  lossless pasteboard fallback, and cursor location. FloatNote's own PID must be
  rejected before AX or pasteboard work begins.
- `selection_intent.rs`, `selection_probe.rs`, `selection_monitor.rs` — pure
  mouse-selection state, macOS Accessibility text extraction, and the dedicated
  listen-only event-tap thread/worker boundary.
- `popup.rs`, `popup_hover.rs`, `shortcuts.rs`, `tray.rs`, `windows.rs`,
  `config.rs` — generation-aware popup cache, macOS passive hover relay, global
  shortcuts, tray menu, window management, and config load/save.
- `testutil.rs` — `#[cfg(test)]` shared `TempDir`/`tempdir()` for tests.

AI settings are one fixed `AiSettings` aggregate in `config.rs`: five provider
profiles plus an optional active ID. Provider save/activation belongs in
`commands/settings.rs`; constructing and swapping the Rust runtime model must
succeed before persistence.

`Config.assistant_output_mode` is `compact` or `detailed`, defaults/falls back to
`compact`, and changes through `set_assistant_output_mode`. Emit
`assistant-output-mode-changed` only after atomic persistence succeeds.

Skill catalog discovery and safe directory import belong to
`commands/agent.rs`; `agent_reload_skills` synchronizes the persisted catalog
into the Rust runtime for the next prompt. `Config.theme` is `system`, `light`, or `dark` and
defaults/falls back to `system`; after a successful generic `set_config` save,
a changed value emits `theme-changed` to every webview. Legacy `font_size`
JSON is ignored and disappears on the next save.

## Conventions

- `rustfmt`, snake_case, `serde`-serializable command payloads.
- Add project-space file operations to `notes.rs`/`project.rs`, not
  `commands.rs`.
- Verify backend changes with `cargo check`, `cargo check --release`, and
  `cargo test --lib` from `src-tauri/`; exercise flows with `npm run tauri dev`.
