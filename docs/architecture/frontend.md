# 前端

FloatNote 使用 Vite 多页面应用：根目录 HTML 是各 WebView 入口。`src/note/main.ts` 只启动笔记窗口；`src/note/note-app.ts` 组装笔记编辑器、项目/文档切换、保存、watcher、助手和窗口事件。

## 边界

- `src/platform/` 是共享 agent/chat invoke/event gateway 与跨 feature DTO 所在处。`selection-popup.ts` 定义划词快照、一次性翻译和关联提问合同，`selection-message.ts` 是首条 selection callout 的唯一 codec。feature 自己的窗口命令仍在相应 feature 内调用；跨 feature 合同应放在这里。
- `src/shared/` 放跨 feature 的 UI、Markdown、escape、快捷键和 toast；不能包含 feature 状态。`src/shared/markdown/render.ts` 是气泡与审查预览共用的安全 GFM renderer，`math.ts` 统一识别 `$...$` / `$$...$$` 并通过受限 KaTeX 配置渲染，`editor.ts` 提供主笔记与助手输入器共用的 Lezer 方言配置和源码保留型轻量 preview；完整笔记 widget 仍留在 `src/note/`。`src/shared/ui/modal-paper.ts` 统一管理 body-level 纸张弹窗的 inert、焦点边界、Escape、portal 注册和焦点恢复。`src/shared/drag-scroll.ts` 统一各 CodeMirror 实例的拖选自动滚动：运行时按 overflowY 定位真实可滚祖先（grow 模式=外层 #piece-scroll，内滚=.cm-scroller），替代 CM 原生在 grow 下把 overflow:visible 的 #piece-editor-root 误判为滚动容器的机制。
- `src/styles/` 是设计系统 token 层（`primitives` → `semantic` → `base`/`components`，由 `index.css` 聚合并被四个窗口链入）；`src/shared/ui/` 放跨窗口共享组件（Button/Icon/Menu/Scrollbar/EmptyState）。详见 `docs/development/design-system.md`。
- `src/note/` 管理 CodeMirror 编辑、项目空间、任务、文本标注、图片与笔记窗口布局。
  Markdown 编辑器使用测量式选区层；live preview 只把独占整行的图片替换为
  figure widget，并以精确源码偏移定位工具栏写回。Tab/Shift+Tab 对多行及完整
  列表子树操作。完整公式在光标位于别处时显示为 KaTeX widget；点击或让选区触碰
  公式区间会恢复原始 Markdown 源码，未闭合公式始终保持源码。
  `font-size.ts` 通过 `--editor-font` 联动 Inbox、Piece 编辑器与写作标题字号，并用
  `localStorage` 保存 12–24px 的窗口本地偏好；Cmd/Ctrl `+`、`-`、`0` 分别增大、
  减小和重置为 15px，不使用 WebView 整页缩放。
  Inbox 的 CodeMirror 文档只包含 clean Markdown；`annotations/state.ts` 的
  `StateField` 持有标签、文本区间和 quote 来源位置，`autosave.ts` 在正文或
  metadata 变化后编码 v2 磁盘快照。右键菜单只作用于 Lezer 识别的可见正文，
  tag filter 使用独立只读分段 projection，不折叠或改写 live editor。
  `piece-switcher.ts` 同时管理版本菜单与预览操作条；`version-preview.ts` 只保存预览前正文的状态语义，CodeMirror 的只读切换由 `editor.ts` 提供。版本列表用主标题与小号时间元信息分层显示，普通版本不显示“手动”来源，AI 快照保留低调标识。
- `src/assistant/` 管理流式聊天、消息 reducer、渲染、技能和 mention 选择器；不得导入 `src/note/` 内部模块。assistant turn 是严格有序的 block 流，连续两个以上 thinking/tool 过程项组成 `process_group`，只有正式 text 会切断过程段；工具状态用稳定 `callId` 更新，不能用“最近一个工具”推断。完整 block 状态与输出显示模式解耦：默认 `compact` 只投影正文、中性状态、错误和流式光标，`detailed` 投影可展开过程段并以流光表示运行项，运行时事件切换只重投影现有状态。AI 与用户气泡使用共享安全 GFM + KaTeX renderer；流式过程中未闭合的公式保留为普通文本，用户消息进入编辑态后仍编辑原始 Markdown。取消 turn 会结束 streaming、保留已有部分内容并追加“已中断”状态，不得复用错误块。写权限审批保留在 dock 卡片：`permission-model.ts` 产生语义标题并把 `tag_text` 的动作、标签与目标文本分开投影，`permission-dialog.ts` 对创建展示完整 Markdown，对 edit/write 默认展示 `permission-diff.ts` 单一行模型生成的响应式源码 diff（审查容器低于 680px 时为统一单栏，否则为对齐双栏），并可切换到完整新版本 Markdown 预览；`permission-bubble.ts` 为标签目标提供六行封顶的全文披露，并按 request id 去重、以 FIFO 顺序逐项审批，完成一个请求只能清除该请求；`permission-allow-button.ts` 处理直接/快照分段写入；对话 action 行仍只读。长输入通过 `input/overlay.ts` 把现有 `.assistant-input-wrap` 移入 `body` 下的聚焦纸张 portal；Floating 与 Inline 共用同一层级和响应式几何，且始终只保留一个 `EditorView`。普通态 Enter 发送、Shift+Enter 换行；聚焦纸张中 Enter 换行且只能点击发送按钮提交。输入器使用共享 GFM parser 与轻量源码 preview，表格和任务列表不替换成 widget。收起或销毁时宿主回到当前 dock，发送仅在 sidecar 返回 request id 后清空并收起，失败则保留草稿；若握手期间文档继续变化，旧完成回调不得清空或收起这份新草稿。scope 或会话 generation 改变后，旧异步提交也不得更新当前 UI。
- `src/history/`、`src/popup/`、`src/settings/` 分别是历史、选中文本弹窗和设置窗口的 UI。划词弹窗由 `state.ts` 的显式状态机在操作条、翻译结果和提问输入间切换；每次异步结果同时校验 `generationId` 与 `popupRequestId`。Assistant 暴露 `startConversationWithPrompt`，由 note controller 为划词提问强制创建独立会话；首条 callout 在当前气泡与历史恢复时都投影为问题和可展开引用卡。

设置窗口由 `src/settings/main.ts` 装配，`shell.ts` 管理原生标题栏下的侧栏与分类
切换，`general.ts` 管理主题与开机启动，`skills.ts` 管理目录清单、启停与导入，
`shortcuts.ts` 管理录制器、渐进披露和冲突反馈。模块通过 `Config` 与显式保存
回调协作，不跨模块查询 DOM。AI 提供商仍由 `provider-settings.ts` 管理六个固定档案，`output-mode.ts` 负责助手简洁/详细显示设置并在保存失败时恢复旧选择。
Skill 候选和设置列表显示目录清单中的 `displayName` 与 `displayDescription`，
但候选引用、启停开关和发送协议始终使用稳定英文 `name`；外部 Skill 未提供
FloatNote 展示元数据时，host 已将显示字段回退到标准 `name` 与 `description`。
列表采用单列行内展开，一次只编辑一家；输入先保存在本地草稿，只有字段合法且
发生变化时才允许显式保存。启用开关与展开状态独立，未保存 API Key 与模型的
档案不可启用，Base URL 只对 OpenAI、Anthropic 与阿里云百炼显示。

外观由 `Config.theme`（`system`、`light`、`dark`）控制，设置窗口的通用页负责保存
选择。各窗口的 `initializeAppearance` 会先使用安全的 `system` 默认值，再读取配置并
订阅 `theme-changed` 事件，以即时同步显式主题切换；编辑器不再注册
Cmd/Ctrl 加减号的应用级字号调整链路。

`shared/note-logic/` 是前端和 sidecar 共享的 workspace package，包含 Inbox v2
codec、文本区间变换、Markdown 语义上下文、精确文本匹配和标签调色板等纯逻辑；
它不依赖 DOM、Node I/O 或 Tauri API。旧 Inbox top-level block parser 已删除。

## 兼容入口

`src/note/agent.ts`、`chat-history.ts`、`chat-history-format.ts`、`inline.ts` 和 `tags/floating.ts` 是兼容 re-export。新跨 feature 调用应改用 `src/platform/` 或 `src/shared/` 的正式入口。
