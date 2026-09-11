# 0005：以结构化文档树作为 Markdown 编辑状态

## 状态

Accepted

## 背景

旧主编辑器在 CodeMirror Markdown 源码上叠加列表编号、缩进、折叠、公式、表格、
图片和引用卡 decoration/widget。多个能力同时改写或隐藏源码区间后，布局、选区、
撤销和 offset 映射彼此耦合；主笔记、助手 composer 与只读界面还维护了不同方言。

## 决策

- Inbox、Piece、独立文档和助手 composer 使用 headless Milkdown + ProseMirror。
- 编辑期间 ProseMirror 文档树是权威状态；Markdown 只在加载、保存、AI payload 和
  外部互操作边界解析或序列化，不持久化 ProseMirror JSON。
- `src/shared/markdown/structured-editor.ts` 是业务唯一适配接口，业务代码不持有
  Milkdown context 或直接替换 EditorState。
- Inbox、Piece 与独立文档由适配器自动获得同一个 `.fn-note-structured-editor`
  表面；feature 代码只能增加领域能力，不能覆盖正文排版、焦点反馈或空白命中行为。
  表面类和 placeholder 通过 Milkdown `rootAttrsCtx` 声明，EditorState 重建后仍必须
  保留；业务句柄的 `element` 始终解析当前 `rootDOMCtx`，不能缓存已被替换的容器。
- CommonMark、GFM、`$...$` / `$$...$$`、图片属性与 `[!quote]` 由一套 Remark
  方言解释；只读界面由同一方言生成安全 DOM。
- CodeMirror 只保留在 `code_block` NodeView 中。折叠等纯视图状态保存在 plugin
  state，不写入 Markdown，也不触发保存。
- Inbox 保持 v2 comment metadata：raw 文件先 decode，clean offsets 投射为可重叠
  annotation marks；保存时按规范化 Markdown 重建 offsets 后 encode。损坏 metadata
  只读打开。

## 结果

Markdown 保存允许规范化列表标记、空行和缩进，但不能丢失可见文本、节点属性、
标注、引用来源、公式或代码。mtime 冲突、原子写入、Tauri command 与 AI wire schema
保持不变。旧主编辑器、feature-local 转发入口及对应样式不再保留。结构化节点和
serializer 的语义往返测试成为发布门禁；浏览器回归同时验证 Inbox/Piece 空白点击、
计算样式与分隔线，跨平台验收继续检查 Chromium/WebKit 的表格、公式、选区和
NodeView 布局。
