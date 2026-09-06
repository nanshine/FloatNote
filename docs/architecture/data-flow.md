# 数据流

## 编辑与保存

笔记窗口从 feature 内的调用点（例如 `notes-state.ts`）调用 Rust command。共享的 agent/chat DTO 与事件入口位于 `src/platform/`。`notes-state.ts` 为每个路径维护防抖保存队列，并把上次读取的 mtime 作为写入前置条件。Rust 检查 mtime、原子写文件，并在写入前登记 watcher 自写抑制；外部变更再以事件返回 WebView。

路径可能整体失效（项目文件夹被改名、移动或删除）。重命名当前活动项目时，前端先把全部 pending 落盘到旧路径，改名成功后用新路径重新走一遍打开项目流程，编辑器引用、watcher 与 active note 一并迁移。若写入重试耗尽、或冲突解决时写读双向都失败，前端丢弃该路径的 pending 并按归属恢复：当前项目的系统文件失效则重新 bootstrap 定位，当前 piece/文档失效则复用“当前文件消失”流程，避免死路径上的保存无限重试、冲突弹窗无限循环。

项目窗口会把当前可编辑笔记注册给 Rust。项目空间中，inbox、tasks 和 piece 都通过同一笔记读写路径处理；独立 Markdown 文件不拥有项目 tasks 面板。

Inbox 在 WebView 内有明确的 raw/clean 边界：磁盘 `_inbox.md` 读取后由
`decodeInbox` 分解为 clean Markdown + `InboxMetadata`，编辑器只接收 clean
Markdown；随后统一 Remark 方言把 clean Markdown 解析为 ProseMirror 文档。编辑期间
结构化文档和 annotation marks 是权威状态；正文事务发生后统一 serializer 生成规范化
Markdown，再由 `encodeInbox` 同步生成一个完整快照，
再交给现有 `scheduleSave` 防抖队列。Rust 始终把内容当作不透明 Markdown 字符串，
因此 mtime、冲突、版本、watcher 和原子写路径不需要第二套存储协议。

## 版本浏览与恢复

点击历史版本时，前端通过 `read_version` 读取快照，在原 ProseMirror 编辑器中切换为只读预览；前端保留进入预览前的完整 EditorState checkpoint，退出时恢复，不触发 autosave，也不创建版本。预览可连续切换多个历史版本，始终保留最初的可编辑状态作为恢复前内容。

用户明确选择“恢复此版本”后，前端先串行等待该路径正在进行的 autosave，并把仍待保存的当前内容写盘，再携带最新 mtime 调用 `restore_version`。Rust 在创建备份前校验 mtime，磁盘已被外部修改时拒绝覆盖；当前内容与目标快照不同时保存一个 `source=restore`、名称为“恢复前备份”的安全版本，然后原子写回目标内容，相同则不制造重复快照。版本行的重命名和删除分别通过独立 command 更新 manifest 或移除对应快照；manifest 先安全替换，删除失败时保留或回滚版本索引，避免先丢快照内容。

## AI 对话与编辑

```text
Assistant UI → src/platform/agent → Tauri command → Rust agent host
                                                    ↕ JSONL
                                              Node sidecar
```

sidecar 将流式对话事件输出到 JSONL；Rust 解析并广播为 `agent://event`，由 `src/platform/agent.ts` 订阅。工具事件携带稳定 `callId`、安全显示标题、语义 `category`、状态和可选短错误，使前端能按真实调用匹配交错执行，并以 Skill、文档读取/查找/搜索、网页搜索/获取、写入、创建、标签和未知工具图标区分动作；原始参数和工具返回正文不进入 UI 协议。`read` 指向受控 Skill 资源时，标题只显示稳定 Skill 名称，不显示本机 `SKILL.md` 绝对路径。模型发出 `toolcall_start` 时，sidecar 先根据已知工具名发送安全、语义明确的 `prepare` 工具事件；同一 `callId` 的实际 `start` 事件再用完整参数原位补充目标信息。mutation 在 Pi `tool_call` hook 中先准备 clean-coordinate 变换，再发 `review_mutation`；Rust 重解析当前 project、校验旧内容并广播结构化 `permission://request`。用户允许后 Rust 返回绑定 conversation/tool call 的短期一次性 lease，工具 `execute` 消费 lease 并发 `commit_mutation`，Rust 再做 stale/create-only 检查、可选快照和原子写入。拒绝、事件广播失败、过期、取消与提交错误都会返回关联结果，不留下悬挂调用。

每次 mutation 成功提交后，Rust 广播 `note://updated`。笔记窗口串行消费这些事件：
piece 写入会立即打开目标文章并退出无文章空态，Inbox 写入切到采集区，tasks 写入刷新并
打开行动面板；一轮内连续写多个文件时逐次跟随。事件只对当前项目或当前独立文档生效，
目标存在未保存的本地编辑时沿用冲突保护，不用磁盘内容覆盖编辑器。

turn 结束事件包含 `completed`、`cancelled` 或 `failed` outcome。取消时前端保留已有
部分输出并显示“已中断”；无输出取消也不会进入空响应错误分支。模型失败显示清理
后的实际错误，空响应提示只用于正常完成却没有任何可见输出的 turn。

Pi session JSONL 是完整会话事实源；`chat-history/index.json` 只保存列表元数据、正文摘要和工具摘要。打开会话是只读操作，不改变 `updatedAt` 或历史顺序；只有 prompt 成功交给 sidecar（包括继续输入、重试、编辑后重发）才刷新活动时间。`session_opened` / `session_synced` 会把 Pi 返回的真实 session 文件路径和摘要同步回索引，但不会把一次查看误记成新活动。打开会话时 sidecar 从活动分支恢复有序 thinking/text/tool blocks，前端始终保存这份完整状态，再按 `assistant_output_mode` 做 compact/detailed 投影；过期会话的乱序 `session_opened` 事件不会覆盖当前明确选择的对话。设置保存成功后 Rust 广播 `assistant-output-mode-changed`，已打开笔记窗口立即重投影，不重新请求模型或改写 session。

重试或编辑历史用户回合是一次 session 分支操作：前端先发 `agent_rewind`，sidecar 将活动 session 叶节点退回到目标用户回合之前；回退成功后前端删除该回合之后的显示消息并发送新 prompt。旧分支不再进入模型上下文，新的完成回合以 `session_synced` 刷新 Rust 的持久化历史索引。

`ls/find/grep/read` 通过 FloatNote inline extension 与 Rust 的 `workspace_list` / `workspace_read` 动态访问当前 project space；具体文件名不注入 system prompt，也不启用 Pi 本地文件工具。`ls` 明确返回一个已选定、平铺的虚拟笔记集合。新建通过 `create_piece(title, content)` 表达，由 sidecar 规范化自然标题，并以 create-only 原子提交拒绝同名竞态；`write` 只覆写已存在的笔记。网络研究仍由原有 `web_search` / `web_fetch` 实现完成，不进入本地写权限流程。

sidecar 对 Inbox 的 read/search/edit 复用同一个 raw/clean codec：读取结果不暴露内部注释，
`tag_text` 与 `edit` 在 clean offsets 上变换 metadata，权限确认时仍把编码后的
完整 Markdown 交给 Rust。权限预览只携带文本摘录与 annotation 数量，不携带 marker。

## AI 提供商保存与切换

```text
设置页草稿 → save_ai_provider / set_active_ai_provider
            → Rust 获取全局 Config 写事务锁，校验并构造候选配置
            → configure(callId) → sidecar 构建候选 PI model
            ← configure_result(callId, ok/error)
            → 成功后以临时文件替换方式持久化 ai_settings 并更新内存状态
```

保存非当前档案不触碰 sidecar。保存当前档案或启用另一家时，sidecar 接受候选后
Rust 才持久化，因此失败不会关闭或覆盖原提供商；sidecar 会先为已打开对话重建
候选会话并整体提交。持久化失败时 Rust 重新下发旧 profile；若此前没有 active
profile，则通过 `clear_configuration` 恢复未配置运行态。关闭当前提供商只持久化
`activeProviderId: null`，随后 `agent_send` 在
host 边界返回“尚未启用 AI 提供商”，不会把 prompt 交给残留运行会话。
成功启用或更新当前提供商后，Rust 广播 `agent://configuration-changed`；助手会重新
打开此前因未配置而失败的活动会话，成功的 `session_opened` 会替换旧配置错误气泡。

应用启动时，sidecar 的配置栅栏默认关闭。Rust 收到 transport `ready` 后，有活动
提供商则下发启动 `configure`，否则下发 `configuration_ready`；先到达的会话恢复
命令会在栅栏后等待，因此 transport ready 不再被误当作模型已经配置完成。

## 全局划词弹窗

```text
CGEvent mouse down/up
  → dedicated listen-only event-tap thread（callback 仅投递元数据）
  → 前台 PID 边界（FloatNote 自身进程静默丢弃）
  → selection_intent worker（拖选/原生双击/原生三击候选）
  → capture（AX focused/children/ancestors → 外部剪贴板兜底）
  → NSPasteboard 全 item/type 恢复；文本相符时附加 HTML
  → popup cache（generationId）
  → selection-popup WebView（测量 → resize → clamp/place → 不主动聚焦 show）
  → popup_hover（仅窗口可见时转发 30Hz 合并后的全局 mouse-move）
  → WebView 局部按钮命中 → `.is-passive-hover`
  → submit_popup_capture
  → quote-captured → inbox editor
```

新鼠标按下会使上一候选失效；抓取前后都检查原生事件代次。event tap 始终
listen-only：弹窗处于被动操作条时，按键和外部点击可异步关闭弹窗且事件继续传给
来源应用；用户进入提问输入态后，普通按键留给输入框，Escape 由弹窗状态机处理。显示
路径不调用窗口 `set_focus()`，用户首次点击弹窗时才允许窗口获得焦点。自动、
弹窗快捷键和直接采集入口都只接受 FloatNote 进程之外的前台 PID；自身窗口内
触发时不读 AX、不访问剪贴板、不显示空结果，也不发送 `quote-captured`。
已从外部应用缓存的弹窗内容不受此限制，用户点击弹窗后仍可正常提交。

弹窗出现本身不会调用模型。用户点击翻译后，Rust 对匹配 generation 做只读快照，
经 `one_shot(callId, task=translate)` 交给 sidecar；该任务不创建 session、不注册工具，
结果以 `one_shot_result` 关联返回，成功、错误、45 秒超时和 sidecar 断开都会移除
host 等待项。翻译不消费 popup cache，新选区到达后旧 `popupRequestId` 的结果只会被
丢弃。

提问通过 `popup-question-request(generationId, popupRequestId)` 交给主窗口：note
controller 读取当前 scope 与 popup 快照，用共享 codec 构造 selection callout，随后
执行 `chatCreate → agentNewSession(callId/result) → optimistic user bubble → agentSend`。只有 sidecar
确认 session 安装完成后才发送 prompt，且只有取得
`agentRequestId` 后才完成 popup generation、显示并聚焦主窗口。此前任一步失败会
删除历史索引、丢弃 sidecar session、best-effort 删除 session 文件并恢复旧会话；
若 session 安装超时后才完成，sidecar 的 discard tombstone 会销毁并删除这份晚到资源；
取得 request ID 后即不再回滚，后续窗口显示失败只提示用户从历史查看。

## 打包时的 AI 启动

开发构建用 sidecar 的本地 `tsx` 启动 `src/main.ts`。发布构建由 Tauri 启动随应用打包的 Node external binary，并把 ESM sidecar bundle 作为第一个参数，因此运行时不依赖用户 PATH、全局 Node 或源码目录。
