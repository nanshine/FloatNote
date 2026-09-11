# shared/note-logic — shared pure note logic

Workspace package `@floatnote/note-logic`, consumed by the frontend (`src/`).
Pure TypeScript, no DOM and no I/O. The Rust Agent owns a narrowly ported codec
subset with cross-language parity tests.
Barrel: `src/index.ts`.

## Modules

- `annotations/codec.ts` — v2 disk metadata ↔ clean Inbox Markdown codec,
  including paired text markers and quote-source metadata.
- `annotations/ranges.ts` — same-tag union/subtraction and text-change mapping.
- `annotations/contexts.ts` — Lezer Markdown eligible-context segmentation and
  read-only projection grouping; code, URL, image, and syntax ranges are excluded.
- `annotations/matching.ts` — exact text plus prefix/suffix disambiguation.
- `tags/model.ts` — the shared `TagDef` DTO only; persistence belongs to the codec.
- `tags/palette.ts` — canonical tag color `PALETTE` (8 swatches) +
  `freeColors(used)`. The Rust Agent mirrors this fixed palette.
- `tasks.ts` was migrated to `src/note/tasks.ts` (frontend-only). The former Inbox top-level block parser and
  block-scoped tag APIs were removed.

Tests: `*.test.ts` next to each module. The only runtime dependency is the
pure `@lezer/markdown` parser; there is no DOM, Node I/O, or Tauri dependency.
