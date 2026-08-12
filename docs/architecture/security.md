# 安全边界

Rust/Tauri 是本地文件、窗口与 sidecar 权限的可信边界。WebView 和 Node sidecar 都不能绕过它直接取得任意用户文件写权限。

## 文件与图片

笔记写入、版本快照和删除经 Tauri command 进入 Rust。图片只能由 `floatnote-img://` 提供：Rust 会 canonicalize 路径，要求文件直接位于 `_assets/`，并要求扩展名属于允许的图片类型。已注册项目根目录之外的资源会被拒绝。

## AI 编辑

sidecar 的虚拟工作区请求由 Rust 重新解析当前 project root，只允许 `_inbox.md`、`_tasks.md` 和根目录 piece；目录分隔符、穿越、未知 `_` 文件、绝对路径及 symlink 逃逸均被拒绝。Skill 绝对路径只允许当前 generation 已授权目录中的普通 UTF-8 文件，并限制为 1 MiB。

本地 mutation 遵循 `tool_call → prepare → review → lease → commit`。批准 lease 随机、短期、一次性，并绑定 conversation 与 `toolCallId`；Rust 在提交时再次检查磁盘旧内容。`create_piece` 是唯一可对应 create 的模型工具，只允许新 piece 且不能覆盖竞态创建的同名文件；`write` 只能对应已有笔记 rewrite，snapshot 只允许现有 piece rewrite。拒绝和错误均返回关联结果。Loose root Markdown 不属于 Agent 能力边界。

## AI 网络读取

`web_search` 与 `web_fetch` 是可见但无需确认的只读工具。网页、搜索摘要和引用卡内容均是不可信资料，不能覆盖系统或用户指令。`web_fetch` 只允许 HTTP(S)，拒绝 URL 凭据、本机、私网、link-local 和非公网 IPv4/IPv6；每个重定向目标都会重新校验，并限制超时、重定向次数、响应类型、字节数和模型可见文本长度。

## WebView 与外链

CSP 在 `src-tauri/tauri.conf.json` 中限制脚本、连接、图片和字体来源，同时显式允许 Tauri IPC 与 `floatnote-img:`。`open_url` 在 Rust 侧复核 URL，仅接受 `http`、`https` 与 `mailto`，而不是信任 WebView 传入的任意 scheme。

## 划词捕获

macOS 划词需要 Accessibility 权限。全局 event tap 是 listen-only，并运行在
Tauri 主 RunLoop 之外，不能消费用户输入。自动、弹窗快捷键和直接采集入口在
读取 AX 或剪贴板前都会拒绝 FloatNote 自身 PID；macOS 剪贴板兜底仅定向发送给
当前外部前台 PID，并以 current-host-only 语义恢复每个可读取的 pasteboard
item/type。Windows 自动捕获从鼠标按下到读取结果始终绑定同一 PID+HWND；复制前
完整验证剪贴板枚举并预分配恢复句柄，跳过可合成表示，增强型图元文件使用专用
GDI 序列化路径；恢复阶段以 FloatNote 主窗口 HWND 取得剪贴板所有权，不使用
`OpenClipboard(NULL)`。用户按住的 Shift/Alt 会在复制组合键期间临时释放并恢复，原本按住
的 Ctrl 不由捕获流程释放。捕获期间目标身份改变或切回 FloatNote 时结果会被丢弃。
