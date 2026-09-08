# Repository Guidelines

## Project Structure & Module Organization

FloatNote is a Tauri 2 desktop app with a Vanilla TypeScript/Vite frontend.
Three components; module-specific guidance exists where it is most needed:

- `src/` — frontend. Vite MPA HTML entries remain at root; `src/platform/`
  owns Tauri commands/events and shared DTOs, `src/shared/` owns cross-feature
  utilities/UI, and `src/note/`, `src/assistant/`, `src/history/`,
  `src/popup/`, `src/settings/` own feature UI.
- `src-tauri/` — Rust backend. `src-tauri/src/` (see its `AGENTS.md`):
  `state.rs` (managed `AppState`), `commands.rs` + `commands/` (thin command
  adapters), `agent/` (in-process Rig runtime, sessions, tools and permissions),
  `notes.rs`/`project.rs`/`versions.rs`
  (note file ops + history), `chat_history.rs`, `paths.rs`, `watcher.rs`,
  `source.rs` (macOS), `testutil.rs`, and window/tray/shortcut wiring.
- `shared/note-logic/` — workspace package `@floatnote/note-logic`: pure
  frontend note logic (`annotations/codec`, range/context
  transforms, `tags/model`, `tags/palette`). See its `AGENTS.md`.
- A **project space** is a subfolder inside the working directory holding up
  to three Markdown kinds: `_inbox.md` (continuous capture text with v2
  range-annotation metadata), `_tasks.md`
  (checklist), and one or more **piece** files (any `.md` without a `_`
  prefix, defaulting to `piece.md`). The `_` prefix alone distinguishes
  system files from pieces. Loose root `.md` files are legacy flat notes.
- `docs/architecture/` documents the system shape: `overview.md`
  (top-level map), `frontend.md`, `backend.md`, `agent-runtime.md`,
  `data-flow.md`, `runtime-boundaries.md`, `packaging.md`, and
  `security.md`. `docs/development/` covers working on the app:
  `setup.md`, `cross-platform.md`, `testing.md`, `design-system.md`,
  and `release.md`. `docs/adr/` holds numbered architecture decision
  records (`NNNN-*.md`) plus `README.md`. These are stable project
  documentation; dated specs/plans are historical implementation
  records. `dist/`, `src-tauri/target/`, `src-tauri/binaries/`, and
  generated build resources are generated artifacts.

## Build, Test, and Development Commands

- `npm run dev` starts the Vite frontend at the dev URL used by Tauri.
- `npm run tauri dev` runs the full desktop app in development mode.
- `npm run build` builds the frontend.
- `npm test` runs frontend/shared and infrastructure unit tests.
- `npm run check` runs frontend/infrastructure tests and builds.
- `npm run ci:local` starts from `npm ci`, then runs the version check and
  complete JavaScript/TypeScript gate. Agents must run it before declaring
  dependency or JavaScript/TypeScript changes complete.
- `npm run release:check -- --tag vX.Y.Z` runs the clean-install gate,
  validates the release tag and runs Rust library,
  debug, and release checks. Run it before creating a release tag.
- `npm run review:ui` runs browser-mode UI regressions against real frontend components without a Tauri binary.
- `npm run review:native:doctor` starts the current Tauri dev source and probes the embedded WebDriver lifecycle.
- `npm run tauri build` creates the packaged desktop app.

Run commands from the repository root unless a Tauri/Rust command specifically requires `src-tauri/`.

## Coding Style & Naming Conventions

Use TypeScript ES modules with explicit imports and focused modules. Existing code uses two-space indentation, double quotes, semicolons, and camelCase function names such as `buildAppendInsert`. Keep DOM/window logic near the related entry module.

Rust code uses `rustfmt`, snake_case module and function names, and Tauri commands in `src-tauri/src/commands.rs`. Keep command payloads serializable with `serde`. When adding project-space operations, extend `notes.rs` rather than adding ad-hoc file logic in `commands.rs`.

## Cross-Platform & Documentation

FloatNote ships on both Windows and macOS, so develop with both targets in mind. Avoid platform-specific assumptions: handle path separators and line endings portably, guard OS-specific APIs (tray, global shortcuts, accessibility, window decorations) behind capability or platform checks, and verify any behavior that differs between the two before relying on it. When a change touches platform-sensitive areas, note the platform impact and, where feasible, exercise the flow on both.

When you are unsure about a Tauri, plugin, or other library API — or need to confirm current behavior, configuration, or migration details — use Context7 to pull the official, up-to-date documentation instead of relying on memory. Prefer this over guesswork whenever an API's exact signature, capability, or version-specific behavior matters.

## Documentation Updates

When a change affects the system's documented surface — module structure, Tauri commands/events or DTOs, project-space file conventions, build/test commands, or cross-platform behavior — update the related docs (`CLAUDE.md`/`AGENTS.md`, and the relevant files under `docs/architecture/`, `docs/development/`, or `docs/adr/`) in the same change. Do not regenerate stable docs wholesale; make focused edits that keep them consistent with the current code.

## Testing Guidelines

Frontend tests use Vitest and are named `*.test.ts` next to the code they cover, for example `src/note/append.test.ts`. Prefer focused tests for pure helpers and state transitions. Run `npm test` before submitting TypeScript behavior changes.

Rust has library tests. For backend changes, run `cargo test --lib` and both
`cargo check` and `cargo check --release` from `src-tauri/`; exercise the
affected Tauri flow with `npm run tauri dev`.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, often with a conventional prefix, such as `feat: implement FloatNote v1`. Keep subjects concise and describe the user-visible change.

Pull requests should include a short summary, test results, and screenshots or screen recordings for UI changes. Link related issues or docs when applicable, and call out any configuration, shortcut, or filesystem behavior changes.

## Security & Configuration Tips

FloatNote reads and writes local Markdown files through Tauri commands. Treat file paths from the frontend carefully, keep permissions scoped in `src-tauri/capabilities/default.json`, and avoid committing machine-specific config or generated app data.
