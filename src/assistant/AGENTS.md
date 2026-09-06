# src/assistant — AI assistant UI

In-window AI tutor chat surface. Streams sidecar events (`agent://event`)
into a reconciled message list with incremental DOM updates.

## Module map

- `assistant.ts` — `AssistantHandle` connector: builds DOM, wires input/
  submit/history/permission/skills/mentions, subscribes to agent events. Its
  `startConversationWithPrompt` public action always creates a fresh conversation,
  renders the optimistic first turn, and compensates creation failures before a
  request id is accepted.
- `render/` — `state.ts` owns the reducer/state machine and `view.ts` owns DOM
  rendering; `index.ts` is the public feature API. Assistant state always keeps
  complete ordered text/thinking/tool blocks. Two or more consecutive process
  items form a `process_group`; only text ends a group. Compact/detailed output
  modes are projections and must not discard state.
- `blocks.ts` — incremental message-list reconciler (`reconcileMessages`).
- `action-card.ts` — read-only action card (edit/tag diff preview, side-by-side
  with `mod`/`add`/`del`/`ctx` row kinds).
- `permission-bubble.ts` — FIFO pending-request controller and compact dock
  card; it is the only permission surface that initiates resolution. Concurrent
  requests are deduplicated by request id and advance only after the current
  request resolves. `tag_text` cards keep action/tag identity separate from an
  expandable, height-capped exact-target surface.
- `permission-model.ts` — pure semantic title, filename, view, and snapshot
  projection. `EditPreviewDetail` and permission payload types live here and
  are re-exported by `permission-bubble.ts` for compatibility.
- `permission-dialog.ts` — complete create-Markdown and edit/rewrite review
  paper. Edit/rewrite review defaults to a container-responsive source diff
  (unified below 680px, aligned two-column at and above 680px) and can switch to
  a rendered new-version preview; `permission-diff.ts` supplies one shared line
  row model and context folding for both layouts.
- `permission-allow-button.ts` — normal/split approval control. Snapshot mode
  is an immediate menu action, not a stored select value.
- Assistant and user bubbles plus permission previews import the safe Remark
  GFM + KaTeX renderer directly from `src/shared/markdown/render.ts` and use the
  shared `.fn-markdown` surface. Inline `$...$` and
  own-line `$$...$$` display formulas share the guarded implementation in
  `src/shared/markdown/math.ts`; never import note
  internals for read-only rendering.
- `input/structured-composer.ts` — the compact Milkdown assistant composer: atomic
  ProseMirror file/skill nodes, unified
  caret-following candidate popover, structured clipboard/send payload, and
  the body-level focused-paper portal. Its modal lifecycle is shared with the
  permission review paper through `src/shared/ui/modal-paper.ts`. The portal moves the existing input
  host into its modal paper and restores it to the current dock; it must never
  create a second editor state. Enter submits in compact mode but inserts a
  newline in the focused paper, where only the send button submits. Composer
  submission is asynchronous: clear and
  collapse only after `send` returns a request id, while failures retain the
  draft. If the user edits while that handshake is pending, the newer live
  draft wins and is not cleared by the older completion. `mention-picker.ts`
  and `skill-picker.ts` remain the data-type sources
  for the composer; their legacy textarea menus are no longer mounted by
  `assistant.ts`. Submission serializes canonical Markdown while extracting
  reference nodes in document order; hidden reference tokens exist only at the
  compatibility clipboard/payload boundary. `input/composer.ts` and its CM
  extensions are legacy test/compatibility modules and are not production-mounted.
- `styles.css` — assistant card/bubble/diff/picker styling.

Tool rows use the sidecar-provided safe `label`, semantic `category`, and stable
`callId`; `action-card.ts` maps the category to a fixed inline SVG and keeps a
tool-name fallback only for older events. Never render raw tool arguments or
result bodies. Compact mode is the default and owns the streaming cursor.
Detailed mode owns process shimmer and expandable groups.

Cross-feature contracts come from `src/platform/`; shared helpers/UI come from
`src/shared/`. Do not import `src/note/` from this feature.
