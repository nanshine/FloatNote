# Rust 后端

`src-tauri/src/lib.rs` 负责应用装配、Tauri invoke handler、窗口、tray 和快捷键注册。`AppState` 保存进程内 `AgentService`、当前活动笔记、结构化 mutation review/lease、watcher 自写抑制和配置。

## 领域与 adapter

- `commands.rs` 与 `commands/{agent,chat,onboarding,settings,versions}.rs` 是 Tauri command adapter。它们只做 payload 转换、授权、错误映射和领域调用；onboarding 进度经专用原子命令保存，通用 `set_config` 会保留当前进度，避免多窗口旧快照覆盖。
- `notes.rs`、`project.rs`、`versions.rs` 负责文件、项目空间和版本快照；项目空间文件操作不应写入 command adapter。
- `agent.rs` 是 `agent/{provider,service,session,skills,tools,workspace}.rs` 的入口，负责 Rig 适配、流事件、会话、受限 project-space 与 mutation transaction。
- `chat_history.rs`、`paths.rs`、`watcher.rs` 处理聊天记录、跨平台路径与文件变更。
- `platform.rs` 封装原生系统边界；`reveal_in_file_manager` command 通过它在 macOS
  Finder 或 Windows 文件资源管理器中定位项目文件夹和独立文档。
- `selection_intent.rs` 是纯鼠标选择状态机；`selection_probe.rs` 通过 macOS
  Accessibility 从 focused element、children、ancestors 读取文本；
  `selection_monitor.rs` 在 macOS 的独立 CFRunLoop 上运行 listen-only event tap，
  Windows 则由可停止的轮询线程识别拖选、双击和 Shift+Click。macOS FFI callback
  只投递元数据，AX、窗口和剪贴板操作全部在 worker 执行；Windows 候选保存 PID 与
  HWND，并将同一目标身份传到捕获完成。自动和快捷键弹窗模式都保留监听器以处理
  外部点击关闭；只有自动模式会把选择手势继续交给捕获流程。
- `popup.rs` 为每次有效捕获分配 `generationId`。提交、关闭和前端 payload
  都携带该代次，过期的异步捕获不能覆盖或关闭更新的弹窗。

文件写入由 Rust 独占。Agent mutation 必须携带与 conversation/tool call 绑定、短期且一次性的批准 lease；提交时再次校验旧内容，创建使用 create-only 原子路径，覆写使用原子替换，可选快照只允许现有 piece rewrite。版本快照与 watcher 自写抑制也在这个边界内执行。版本预览只调用只读的 `read_version`；恢复携带 expected mtime，通过冲突检查后才写回正文，并仅在当前内容与目标版本不同时新增一个名为“恢复前备份”的安全快照。版本名称保存在 manifest 的 `summary` 字段；manifest 经临时文件安全替换，删除版本先更新索引再移除对应 Markdown 快照，失败时避免留下指向已丢失内容的条目。

聊天历史索引的所有进程内读改写由同一把锁串行化，并通过同目录临时文件原子替换。
`updatedAt` 只表示最后一次 prompt 活动；查看或恢复会话只读取记录并绑定 Rust
session 路径，不更新时间或排序。加载索引时会按 legacy Pi session header 修复
旧版时间戳文件名、合并仍有 JSONL 的有效备份记录，并把曾因错误路径而分裂的两个
session 都保留下来；从未形成持久 session 的空白“新对话”不进入历史列表。

划词弹窗显示时不主动聚焦，但允许用户首次点击时成为 key window 并立即
执行按钮。macOS 由 `popup_hover.rs` 在弹窗可见期间单独启用 listen-only
mouse-move event tap，以有界通道和 30Hz 节流向 WebView 转发坐标；它不与
`selection_monitor.rs` 的 down/up/key 队列共享容量。自动、弹窗快捷键与
直接采集入口都会在 AX 和剪贴板操作前拒绝 FloatNote 自身 PID，因此本软件
任意窗口内的划词捕获均静默无效。macOS 外部应用使用 AX-first 捕获并允许定向
`Cmd+C` 兜底；Windows 剪贴板捕获在复制前后校验相同 PID+HWND，完整枚举并预分配
恢复数据，忽略可由 Windows 重建的合成格式并专门复制增强型图元文件。自动失败静默，专用快捷键在外部
应用无有效选区时仍允许显示短暂的空结果反馈。已缓存的外部选区可在弹窗成为
前台窗口后正常提交。

AI 配置以 `Config.ai_settings` 持久化：五个固定 provider profile 加一个可空的
`active_provider_id`，不再读取旧的单 provider 或通用 connection 字段。
`save_ai_provider` 保存未启用档案时直接落盘；保存当前档案或
`set_active_ai_provider` 切换提供商时，先成功构造并交换 Rig model，再写入
配置文件。所有 `Config` 写入（provider、通用设置、快捷键、窗口状态和工作目录）
共用异步事务锁，配置文件先写同目录临时文件
再替换；配置或持久化失败会保留原 active profile，并确认恢复旧运行配置；
关闭最后一家同时清除进程内 model。旧百炼配置在加载时删除；兼容服务通过 OpenAI Base URL 使用。

Skill 目录清单由 Rust host 直接从打包资源、debug `resources/skills` 回退目录和
`~/.floatnote/skills` 读取，返回 `name`、`description`、`displayName`、
`displayDescription`、`source` 与 `enabled`。前两个字段是稳定英文运行时元数据；
后两个字段读取 `SKILL.md` 的 `metadata.floatnote-display-name` 与
`metadata.floatnote-short-description`，缺失时分别回退到前两个字段，
内置目录还受当前内置 Skill ID 清单约束，陈旧的
打包资源目录不会重新进入目录清单；debug 构建优先读取源码
`resources/skills`，不使用 `target` 中可能残留的资源副本。导入只接受根部含精确
`SKILL.md` 的目录，校验
元数据和重名后递归复制整个目录；符号链接被拒绝，复制先写临时目录再原子重命名。
启停状态先写 `disabled_skills`，Rust Agent 在下一 prompt snapshot 使用新目录。

`Config.theme` 持久化 `system`、`light` 或 `dark`，未知值回退为 `system`；成功保存
主题变更后 host 广播 `theme-changed`。Serde 会忽略旧配置中的 `font_size`，后续原子
保存自然清除遗留键，不需要破坏性迁移。

`Config.onboarding` 保存版本、状态、步骤及首次采集成功标记。配置文件不存在代表新安装；已有文件缺少该字段时迁移为 `completed`，不会向升级用户自动弹出。`get_onboarding_state` / `set_onboarding_state` 与 `onboarding://changed` 构成跨窗口合同，debug-only preview 则只保存在 `AppState` 内存并广播 `onboarding://preview-changed`。

`paths.rs` 在 setup 最早阶段解析一次运行档案。release 继续使用平台 `app_config_dir/config.json` 与 `~/.floatnote`；debug 使用 `src-tauri/target/dev-profiles/{profile}` 下的 `config.json`、`data/chat-history`、`data/skills` 和 `workspace`，其中 `FLOATNOTE_DEV_PROFILE` 仅在 debug 生效。所有聊天历史和导入 Skill 均通过这一解析器取路径。

`get_ai_readiness` 在配置事务锁内返回 `unconfigured`、`disabled`、`incomplete`
（含不带凭证的说明）、`runtime_unavailable` 或 `ready`，同时检查配置与实际 model，
不发出网络请求；`retry_ai_configuration` 可重建当前 model。所有提供商保存成功后均发出
`agent://configuration-changed`，助手收到事件后重新查询状态。读取已有 session 不要求启用模型，
发送仍由后端检查。`open_ai_settings` 将导航目标保存到独立的 `SettingsNavigation`
managed state，设置前端在监听就绪后调用 `take_settings_navigation` 消费，跨 macOS/Windows
均不依赖窗口加载时序或延时。
