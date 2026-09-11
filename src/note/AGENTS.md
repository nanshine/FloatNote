# src/note — note window

The main note window (Milkdown/ProseMirror editor + inbox/pieces/tasks + assistant).
Entry: `main.ts` calls async `startNoteApp()` in `note-app.ts`. Inbox and piece/document
editors share `src/shared/markdown/structured-editor.ts`; Markdown is only the
load/save/interoperability boundary, while ProseMirror state is authoritative during edits.

## Module map

- `updates.ts` — 唯一更新协调器，后台检查和安装前保存屏障。
- `notes-state.ts` — Tauri call wrappers (read/list/create/rename/delete) +
  per-path debounced save queue (`scheduleSave`/`saveImmediate`/`flushAll`)
  with mtime conflict guard. `loadNote` registers last-known mtime.
- `structured-inbox.ts` — Inbox v2 metadata ↔ ProseMirror annotation-mark bridge,
  tag menu/filter projection, routed quote capture, and encoded autosave snapshots.
- `capture.ts` — shared quote insertion/source merging for inbox and standalone
  document editors; `note-app.ts` routes capture events by the current session.
- `structured-media.ts` — structured-editor image paste/native drop adapter.
- Inbox, piece, and standalone-document bodies receive the same
  `.fn-note-structured-editor` surface from `structured-editor.ts`; Inbox code may
  add annotation marks and projections but must not fork body typography, block
  rendering, focus chrome, or empty-space hit behavior.
- `tasks-panel.ts` — `_tasks.md` checklist panel (render, mutate, drag-reorder,
  filter). Imports task logic from `./tasks` (migrated from shared).
- Annotation definitions and the canonical palette come directly from
  `@floatnote/note-logic`; they remain plugin/domain state and never become
  visible Markdown.
- `piece-switcher.ts`, `seg-switch.ts`, `split.ts`, `layout*.ts`,
  `topbar.ts` — layout/view switching.
- `onboarding.ts` — persisted six-step onboarding, anchored coach marks,
  capture permission guidance, preview overrides and split-window expansion.
- `image-fs.ts` and `image-attrs.ts` retain the filesystem protocol and Markdown
  attribute codec; structured image node views own caption/width/alignment UI.
- `recent-projects.ts` — MRU list helpers.
- `append.ts`, `quote.ts` (quote-card-specific ranges and minimal append),
  `versions.ts`, `window-state.ts`, and `shortcuts.ts` are focused note-window
  helpers. Cross-feature agent, chat-history, Markdown, empty-state, and
  scrollbar code is imported directly from `src/platform/` or `src/shared/`.

Tests: `*.test.ts` next to each module (Vitest, pure-logic style).
