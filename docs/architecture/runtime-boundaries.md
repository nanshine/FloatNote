# 运行时边界与数据流

```text
WebView → src/platform → Tauri command → Rust domain
                                      ↕
                           JSONL stdin/stdout protocol
                                      ↕
                                Node sidecar
```

## 笔记写入

前端自动保存与直接编辑经 Tauri command 到 Rust `notes`。Rust 执行 mtime 冲突校验、原子写入和 watcher 自写抑制。sidecar 的写入请求不会直接触及文件系统：Pi hook 先 prepare/review，Rust 发放一次性 lease；工具执行时 Rust 再 stale-check 并原子提交，随后广播 `note://updated`。

Inbox 的 v2 metadata 编解码只发生在 frontend/sidecar 的共享纯逻辑边界；
ProseMirror annotation marks 通过 serializer source alignment 投影回 clean Markdown
offsets，Agent 继续消费同一 clean 坐标；Rust host 继续传递并持久化不透明
字符串。metadata 不进入可编辑文档，也没有数据库或第二个 metadata 文件。

## AI 对话

sidecar 通过 JSONL 发出流式事件、虚拟工作区读取和 mutation transaction。Rust 只暴露当前 project space 的平面 Markdown 能力，处理 review/lease/commit，并将安全事件广播为 `agent://event`。`ls/read/find/grep/edit/write/create_piece` 都是 FloatNote adapter，不是 Pi 本地文件系统工具；其中 `create_piece` 接受自然标题，`write` 只接受已存在的根级笔记标识。前端 `src/platform/agent.ts` 是事件和 invoke API 的唯一入口。

Skill 目录由 Rust 授权后下发。Pi ResourceLoader 生成原生 `<available_skills>` 并处理 `/skill:name`；Skill 资源读取仍经过 sidecar generation 的 realpath containment。FloatNote 的基础系统提示不复制 Skill catalog。

## 图片与外部链接

图片通过自定义 `floatnote-img://` 协议读取，Rust 仅允许 `_assets` 下的已知图片后缀。外部链接由 Rust `open_url` 再次校验，只允许 `http`、`https`、`mailto`。CSP 明确允许 Tauri IPC、资源字体和自定义图片协议，避免 WebView 处于无策略状态。
