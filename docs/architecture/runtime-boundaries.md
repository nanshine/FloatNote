# 运行时边界与数据流

```text
WebView → src/platform → Tauri command → Rust AgentService → Rig provider
                                      ↘ Rust tools/session/permissions
```

## 笔记写入

前端自动保存与直接编辑经 Tauri command 到 Rust `notes`。Rust 执行 mtime 冲突校验、原子写入和 watcher 自写抑制。Rig 工具先 prepare/review，Rust 发放一次性 lease；执行时再次 stale-check 并原子提交，随后广播 `note://updated`。

Inbox 的 v2 metadata 编解码分别发生在 frontend 和经过 parity 测试的 Rust Agent codec；
ProseMirror annotation marks 通过 serializer source alignment 投影回 clean Markdown
offsets，Agent 继续消费同一 UTF-16 clean 坐标；文件层继续持久化不透明
字符串。metadata 不进入可编辑文档，也没有数据库或第二个 metadata 文件。

## AI 对话

Rig stream 由 Rust 直接转换为 `agent://event`。`ls/read/find/grep/edit/write/create_piece` 都是 FloatNote adapter，而不是通用文件工具；其中 `create_piece` 接受自然标题，`write` 只接受已存在的根级笔记标识。前端 `src/platform/agent.ts` 仍是事件和 invoke API 的唯一入口。

Skill 目录由 Rust 授权并形成 prompt-boundary snapshot。Rust 生成 `<available_skills>`，直接注入选中 Skill 的正文；Skill 资源读取经过当前 snapshot 的 realpath containment。

## 图片与外部链接

图片通过自定义 `floatnote-img://` 协议读取，Rust 仅允许 `_assets` 下的已知图片后缀。外部链接由 Rust `open_url` 再次校验，只允许 `http`、`https`、`mailto`。CSP 明确允许 Tauri IPC、资源字体和自定义图片协议，避免 WebView 处于无策略状态。

## 外部选区

输入监听 → 事件 epoch/目标/释放位置快照 → `selection_worker` 最新请求槽 →
AX（macOS）或独立 MTA UIA（Windows）→ 必要的剪贴板兜底 → 来源查询 →
再次校验 epoch/目标 → popup generation 缓存。输入线程不等待取词，COM 对象不跨线程。
自动 AX/UIA 成功不触碰剪贴板；确认采集时仅为仍匹配的原选区补齐 HTML，异步完成后
重新校验 generation，失败则使用缓存纯文本。快捷键采集继续保留富文本。
