# Rust Agent runtime

FloatNote 的 AI Agent 与 Tauri backend 运行在同一 Rust 进程中。`agent/service.rs`
管理 Provider、会话和运行任务，`agent/rig_adapter.rs` 是唯一可直接导入 Rig crate 的
适配边界；依赖精确锁定为 Rig 0.42.0，升级必须单独验证。

显式 Provider 为 OpenAI、Anthropic、DeepSeek、Kimi 和智谱。OpenAI 官方地址使用
Responses API，自定义 Base URL 使用 Chat Completions；Kimi 固定中国区 Moonshot
地址，智谱覆盖为中国区 Z.ai 地址。其他 OpenAI-compatible 服务通过 OpenAI 的
Base URL 配置，不拥有独立 Provider。FloatNote 不按模型名强制启用 reasoning，
但会透传、显示并持久化 Provider 返回的 reasoning。

Rig 提供流式模型调用、工具循环和生命周期 hook；FloatNote 将正文、reasoning 和
工具阶段直接映射为 `agent://event`。每个请求最多 12 次模型调用、一次非法工具
重试，工具并发固定为 1。取消由 FloatNote 保存的 `AbortHandle` 控制，不依赖 Rig
内部 session；取消或失败时已显示的部分内容作为 display-only 记录持久化，不进入
后续模型上下文。

## 会话与上下文

会话是 FloatNote v1 JSONL：header 后跟带稳定 `id`/`parentId` 的消息、展示记录和
head-move 记录。rewind 把 head 移到目标用户消息之前，下一条消息形成新分支。
旧 Pi v1–v3 会话首次打开时只导入文件最后节点所在的活动分支，原文件保留为
`.pi-v3.bak`；迁移文件通过同目录临时文件原子替换。

持久历史不做摘要压缩。每次请求根据 64K 本地估算 token 预算从新到旧选择完整
turn，并保持 tool-call/result 配对；ASCII 约按四字符一个 token、非 ASCII 按一个
字符一个 token。单轮工具结果累计超过 32K 估算 token 时，后续结果改为截断提示。

## Skills、工具与权限

Rust 在 prompt 边界取得不可变 Skill snapshot，基础提示中加入可用摘要，选中的
`SKILL.md` 作为独立受信任块注入；Skill 资源读取要求 realpath 位于当前 snapshot
目录并小于 1 MiB。

工具包括 `ls/read/find/grep/edit/write/create_piece`、Inbox 标签工具以及
`web_search/web_fetch`。写操作继续遵循
`prepare → review → one-use lease → stale-check → atomic commit`。Agent 与文件逻辑
同进程并不放宽边界：模型参数仍是不可信输入，路径、操作类型、旧内容和 lease
在提交前重新校验。网页读取禁用代理、固定经校验的 DNS 地址，并逐跳检查重定向，
拒绝本机、私网、link-local、非文本响应和超过 1 MiB 的正文。
