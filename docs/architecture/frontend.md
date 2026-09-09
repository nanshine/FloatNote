# 前端

FloatNote 使用 Vite 多页面应用：根目录 HTML 是各 WebView 入口。`src/note/main.ts` 只启动笔记窗口；`src/note/note-app.ts` 组装笔记编辑器、项目/文档切换、保存、watcher、助手和窗口事件。

## 边界

- `src/platform/` 是共享 invoke/event gateway 与跨 feature DTO 所在处。`onboarding.ts` 统一引导状态、权限、runtime profile 与 preview 合同；`selection-popup.ts` 定义划词快照、一次性翻译和关联提问合同，`selection-message.ts` 是首条 selection callout 的唯一 codec。feature 自己的窗口命令仍在相应 feature 内调用；跨 feature 合同应放在这里。
- `src/shared/` 放跨 feature 的 UI、Markdown、escape、快捷键和 toast；不能包含 feature 状态。`src/shared/markdown/structured-editor.ts` 是唯一编辑边界，headless Milkdown 组装 ProseMirror、CommonMark/GFM、公式、自定义节点和 parser/serializer；业务层只调用其 load/replace/checkpoint/read-only/selection 接口。`milkdown-plugins.ts` 持有列表折叠、公式、嵌套代码编辑器、表格工具、图片、引用卡、annotation mark 与 assistant ref。`render.ts` 从同一 Remark GFM/Math 方言产生安全只读 HTML，原始 HTML 与远程图片不会执行或加载。`src/shared/ui/modal-paper.ts` 统一管理 body-level 纸张弹窗的 inert、焦点边界、Escape、portal 注册和焦点恢复。
- `src/styles/` 是设计系统 token 层（`primitives` → `semantic` → `base`/`components`，由 `index.css` 聚合并被四个窗口链入）；`src/shared/ui/` 放跨窗口共享组件（Button/Icon/Menu/Scrollbar/EmptyState）。详见 `docs/development/design-system.md`。
- `src/note/` 管理结构化编辑、项目空间、任务、文本标注、图片与笔记窗口布局。
  `onboarding.ts` 是非模态引导 controller，负责状态持久化、内容卡、锚定 coach mark、窗口自动扩宽和确认退出；新建与打开已有项目均进入五步引导，独立文档只介绍写作与 AI。行动步骤只展开面板，不创建空待办；行动、双栏和 AI 打开后显示本步结果卡，用户点击下一步或完成才推进，也可跳过，返回不会撤销已写入的内容。`structured-inbox.ts` 在捕获内容确实插入并排入保存后通过 `onCaptureCompleted` 通知它。
  Inbox、Piece 和独立文档不仅共享真实 ProseMirror 文档树，也共享唯一的
  `.fn-note-structured-editor` 正文表面；字体、段落与块级样式、焦点反馈、空文档满高和
  留白点击行为不能在 feature 层分叉。Inbox 只额外提供标签栏、annotation marks、
  筛选 projection 与外部采集入口。列表编号由 `ordered_list.order`
  与 `<ol>` 处理，列表后段落不继承缩进；折叠只存在 plugin decoration state。公式是
  KaTeX 原子节点，表格、任务项、图片属性和引用卡均为可交互结构化节点；只有代码块
  NodeView 内保留隔离的 CodeMirror，并按语言懒加载高亮。
  空文档的 ProseMirror 编辑面铺满所属滚动区，点击正文留白也会把光标定位到空段落；
  placeholder 按 ProseMirror 的空段落结构显示。普通引用可用 CommonMark `> ` 或
  `/quote `（中文 `/引用 `）输入规则创建，两者都生成原生 `blockquote` 节点。
  `font-size.ts` 通过 `--editor-font` 联动 Inbox、Piece 编辑器与写作标题字号，并用
  `localStorage` 保存 12–24px 的窗口本地偏好；Cmd/Ctrl `+`、`-`、`0` 分别增大、
  减小和重置为 15px，不使用 WebView 整页缩放。
  Inbox 先 `decodeInbox`，再把 v2 ranges 映射为允许重叠的 annotation marks；标签定义
  留在领域/plugin state。保存时 serializer 重建规范 Markdown offsets 后调用
  `encodeInbox`，磁盘协议与 Rust Agent clean-coordinate 规则一致。损坏 metadata 以只读模式打开，避免
  静默覆盖。tag filter 使用独立只读 projection，不改写编辑文档。
  `piece-switcher.ts` 同时管理版本菜单与预览操作条；版本预览保存完整 EditorState
  checkpoint、以无历史替换展示快照，退出后恢复原状态。
- `src/assistant/` 管理流式聊天、消息 reducer、渲染、技能和 mention 选择器；不得导入 `src/note/` 内部模块。assistant turn 是严格有序的 block 流，连续两个以上 thinking/tool 过程项组成 `process_group`，只有正式 text 会切断过程段；工具状态用稳定 `callId` 更新，不能用“最近一个工具”推断。完整 block 状态与输出显示模式解耦：默认 `compact` 只投影正文、中性状态、错误和流式光标，`detailed` 投影可展开过程段并以流光表示运行项，运行时事件切换只重投影现有状态。AI 与用户气泡使用共享安全 GFM + KaTeX renderer；流式过程中未闭合的公式保留为普通文本。取消 turn 会结束 streaming、保留已有部分内容并追加“已中断”状态，不得复用错误块。写权限审批保留在 dock 卡片并复用同一只读 renderer。长输入通过 `input/overlay.ts` 移动同一个紧凑 Milkdown 宿主；普通态 Enter 发送，展开态 Enter 执行结构化换行。文件和 Skill 是 `assistant_ref` 原子节点，自定义 MIME 可恢复节点、纯文本可读；提交时 serializer 输出 `userText`，引用按文档顺序进入原 wire schema，失败或并发新编辑不会丢草稿。无配置的空对话在真实消息区显示设置入口；已配置空对话显示可折叠的三条 starter，它们只填充 composer，文件 starter 在一个 ProseMirror transaction 中插入引用节点与模板后缀。
- `src/history/`、`src/popup/`、`src/settings/` 分别是历史、选中文本弹窗和设置窗口的 UI。划词弹窗由 `state.ts` 的显式状态机在操作条、翻译结果和提问输入间切换；每次异步结果同时校验 `generationId` 与 `popupRequestId`。Assistant 暴露 `startConversationWithPrompt`，由 note controller 为划词提问强制创建独立会话；首条 callout 在当前气泡与历史恢复时都投影为问题和可展开引用卡。

设置窗口由 `src/settings/main.ts` 装配，`shell.ts` 管理原生标题栏下的侧栏与分类
切换，`general.ts` 管理主题与开机启动，`skills.ts` 管理目录清单、启停与导入，
`shortcuts.ts` 管理录制器、渐进披露和冲突反馈。模块通过 `Config` 与显式保存
回调协作，不跨模块查询 DOM。AI 提供商由 `provider-settings.ts` 管理五个固定档案，`output-mode.ts` 负责助手简洁/详细显示设置并在保存失败时恢复旧选择。
`onboarding-lab.ts` 管理通用页的重播入口和仅 debug 可见的场景预览；设置 shell 在挂载前缓存 `settings://navigate`，因此助手配置入口可稳定深链到 AI 分类。
Skill 候选和设置列表显示目录清单中的 `displayName` 与 `displayDescription`，
但候选引用、启停开关和发送协议始终使用稳定英文 `name`；外部 Skill 未提供
FloatNote 展示元数据时，host 已将显示字段回退到标准 `name` 与 `description`。
列表采用单列行内展开，一次只编辑一家；输入先保存在本地草稿，只有字段合法且
发生变化时才允许显式保存。启用开关与展开状态独立，未保存 API Key 与模型的
档案不可启用，Base URL 只对 OpenAI 与 Anthropic 显示；OpenAI-compatible 服务复用 OpenAI 档案。

外观由 `Config.theme`（`system`、`light`、`dark`）控制，设置窗口的通用页负责保存
选择。各窗口的 `initializeAppearance` 会先使用安全的 `system` 默认值，再读取配置并
订阅 `theme-changed` 事件，以即时同步显式主题切换；主笔记继续提供
Cmd/Ctrl 加减号与 0 的编辑器字号调整，并通过共享 `--editor-font` 同步 Inbox、Piece
正文和写作标题。

`shared/note-logic/` 是前端纯逻辑 workspace package，包含 Inbox v2
codec、文本区间变换、Markdown 语义上下文、精确文本匹配和标签调色板等纯逻辑；
它不依赖 DOM、Node I/O 或 Tauri API；Rust Agent 以独立端口和 parity 测试消费相同磁盘格式。
