# 发布流程

FloatNote 的 macOS 和 Windows x86_64 安装包由 GitHub Actions 构建。推送版本标签后，工作流分别在原生 Apple Silicon 与 Intel runner 上构建 `.dmg`，使用 Developer ID Application 签名并提交 Apple 公证。新标签会先创建 Draft、Prerelease GitHub Release 供检查，公开 Draft 时再决定保留 Prerelease 标记或提升为正式 Release；只允许重跑尚未公开的 Draft，已公开版本必须通过新版本号修复。

## 日常验证

`.github/workflows/ci.yml` 在推送 `main` 和 Pull Request 时运行：

- `npm ci`、`npm run version:check`、`npm run check`；
- macOS 与 Windows 上的 `cargo test --lib`、`cargo check` 和 `cargo check --release`。

提交前可在仓库根目录运行等价的本地 JS/TS 门禁：

```bash
npm run ci:local
```

它从全新 `npm ci` 开始，可提前发现 manifest 与 lockfile 不同步的问题。

## Apple 签名与公证凭据

发布工作流只在版本标签或手动发布任务中读取以下 GitHub Actions repository secrets；Pull Request 工作流不会获得这些凭据：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12` 的单行 Base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_ISSUER` | App Store Connect Team API Key 的 Issuer ID |
| `APPLE_API_KEY_ID` | Team API Key 的 Key ID |
| `APPLE_API_PRIVATE_KEY` | `AuthKey_<KEY_ID>.p8` 的单行 Base64 |
| `APPLE_TEAM_ID` | 签发 Developer ID 证书的 Apple Developer Team ID |

每个 macOS runner 会把证书导入临时钥匙串，只接受唯一的 `Developer ID Application` 身份，并确认身份名称末尾的 Team ID 与 `APPLE_TEAM_ID` 一致。工作流随后从该证书动态生成 `APPLE_SIGNING_IDENTITY`，无需把个人姓名或证书全名写入仓库。

Team API 私钥只会解码到 runner 的临时目录，并通过 `APPLE_API_ISSUER`、`APPLE_API_KEY` 和 `APPLE_API_KEY_PATH` 交给 Tauri。runner 结束后临时钥匙串和私钥会随环境销毁。证书或 API Key 被撤销、轮换后，必须同步更新对应 secrets；不要将 `.p12`、`.p8`、密码或 Base64 中间文件提交到仓库。

## README 下载入口

README 的下载链接统一使用 GitHub 的 `releases/latest` 入口，自动跟随最新正式 Release，无需在发版时修改版本号。用户在发布页的 Assets 中选择对应平台的安装包；安装包文件名包含版本号，因此不要将旧文件名拼接到 latest 下载 URL。Prerelease 不作为 README 的默认下载目标，可通过所有版本入口查看。

## 准备版本

根 `package.json` 是应用版本的唯一来源，`src-tauri/tauri.conf.json` 直接读取它。Cargo、workspace package 和 lockfile 中仍需保留相同版本，由脚本统一维护：

```bash
npm run version:set -- 0.2.0
npm run version:check
```

检查版本改动和发布内容，运行发布预检，然后提交：

```bash
npm run release:check -- --tag v0.2.0
```

发布预检依次执行 clean install、带 tag 的版本校验、完整 JS/TS 检查，以及 `cargo test --lib`、`cargo check`、`cargo check --release`。任一步失败都会立即停止。它不会创建 Git tag、GitHub Release 或上传资产。

回到仓库根目录，创建与项目版本完全一致的 `v` 前缀标签：

```bash
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

`release.yml` 会校验 `v0.2.0` 与项目版本 `0.2.0` 是否一致；不一致时不会构建或创建 Release。也可以在 GitHub Actions 页面手动运行该工作流，但输入必须是已经存在的版本标签。

双架构 DMG、原生 runner 架构、GitHub 权限、证书导入、Apple 公证、Draft Release 创建与资产上传只能由 GitHub Actions 最终验证。发布任务显式请求 `app,dmg` 两种 bundle；这会让 `.app` 作为最终产物保留到验证和归档阶段，而不是在 DMG 构建后作为中间产物被 Tauri 清理。修改 Tauri bundling、resources、entitlements 或签名配置时，还应在匹配架构的 macOS 机器上额外运行 `npm run tauri build`；日常发布预检不重复这项耗时构建。

## 审核或更新 Prerelease

`prepare_release` job 会先验证标签。没有对应 Release 时，它会创建 Draft Prerelease；已有 Release 时，只有仍为 Draft Prerelease 才会复用该 Release。随后把 Release ID 交给构建任务，避免并行构建竞相创建 Release。macOS 两个架构任务分别上传：

- `aarch64`：Apple Silicon 的 `.dmg` 和 `.app.tar.gz`；
- `x86_64`：Intel Mac 的 `.dmg` 和 `.app.tar.gz`。

macOS 用户首次安装下载 `.dmg`；`.app.tar.gz` 是应用内更新包，完成签名、公证、staple 和归档后使用 Tauri signer 生成 `.sig`。Windows x86_64 构建生成 NSIS `-setup.exe` 和对应 `.sig`，同一 EXE 用于首次安装和更新。Updater 签名不等于 Windows Authenticode 签名；当前 Windows 工作流尚未配置代码签名证书。

每个构建任务会在上传前验证对应产物：

- `codesign --verify --deep --strict` 检查应用及其嵌套代码签名；
- `codesign -dvvv` 检查 Developer ID Authority 与 `APPLE_TEAM_ID`；
- `xcrun notarytool submit --wait` 显式提交 DMG 公证，成功后再 staple 票据；
- `xcrun stapler validate` 检查 `.app` 和 `.dmg` 的公证票据；
- `spctl --assess` 检查 Gatekeeper 对 `.app` 和 `.dmg` 的判断。

签名、公证或验证失败时不会上传该架构的资产。缺少预期的 `.app` 或 DMG 时，工作流会输出该 target 的 bundle 目录树，便于区分构建失败、产物改名和 Tauri 清理行为。上传阶段会按资产名替换同一 Release 中的旧版本。如果目标还是 Draft，上传中途失败时不要人工发布；公开的 Release 禁止重跑替换文件，避免客户端持有旧清单却下载到新字节。

新建 Release 时，GitHub 会根据模板正文加入架构选择说明并自动生成提交记录。复用已有 Prerelease 时，工作流只替换同名产物，不会更新现有正文；三平台构建任务成功后，应人工校对并更新说明，同时保留已有的自动生成 changelog。公开前应人工补充或整理以下内容：

```markdown
## 新功能
- ...

## 修复
- ...

## 已知问题
- 按实际测试结果填写。
```

至少下载并验证当前机器对应的 `.dmg`：

1. 在未安装 Node 的干净用户环境中安装 FloatNote；
2. 从 Finder 正常打开应用，确认无需“仍要打开”绕过 Gatekeeper；
3. 发送一条只读 Agent 对话；
4. 确认写入权限气泡和应用写入；
5. 重启后确认聊天恢复。

确认 Release 标题、说明、两种架构的 `.dmg`/应用归档、Windows 安装包、更新签名及公证检查和功能测试结果后，再在 GitHub 发布 Draft。预览版本保留 Prerelease 标记；正式版本应在首次公开 Draft 时取消该标记，使 `release: published` 事件直接生成正式清单。已公开版本如需修改程序，必须提升版本号并创建新标签。

若一个已公开的 Prerelease 只需要提升发布级别而不改变二进制，可以取消 Prerelease 标记，再手动运行 **Publish update feed** 并输入该标签，以补充 `stable.json`；不要重新上传或覆盖已公开资产。

还可以对下载后的 DMG 再做一次独立验证：

```bash
xcrun stapler validate "FloatNote_0.2.0_aarch64.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 \
  "FloatNote_0.2.0_aarch64.dmg"
```

挂载 DMG 后检查应用；根据卷名或实际挂载点调整路径：

```bash
codesign --verify --deep --strict --verbose=2 "/Volumes/FloatNote/FloatNote.app"
codesign -dvvv "/Volumes/FloatNote/FloatNote.app"
xcrun stapler validate "/Volumes/FloatNote/FloatNote.app"
spctl --assess --type execute --verbose=4 "/Volumes/FloatNote/FloatNote.app"
```

`codesign -dvvv` 应显示 `Authority=Developer ID Application: ...`，并且 `TeamIdentifier` 应与 GitHub secret `APPLE_TEAM_ID` 相同；`spctl` 应将来源识别为已公证的 Developer ID。

## 本地打包

应用图标母版位于 `src-tauri/icons/app-icon.png`。它基于历史原图进行保守修复，保留原始纸张和符号，仅移除了外围白色画布，并保持满幅方形作为唯一权威源。`npm run icon:generate`（`scripts/app-icon.mjs`）在母版基础上派生各平台资源：先把母版内缩到约 88% 居中放在透明画布上（四周约 6% 透明留白）、再对其外框施加约 12% 的克制圆角（参照微软 Windows 图标 48px 网格：外圆角小、带留白），生成中间产物 `app-icon-rounded.png`，随后交给 `tauri icon` 展开为 PNG、ICNS、ICO 及 iOS、Android、Windows Store 尺寸。这样 Windows 任务栏/桌面显示为一个四周留白、圆角克制的浮起方块，而非顶满边框的生硬直角方块（macOS 系统本身也会裁圆角）。修改母版后先重新生成，并检查变更，再进行打包：

```bash
npm run icon:generate
```

同一命令还会从机器人剪影母版 `src-tauri/icons/tray-source.png` 重建 Windows 托盘图标 `tray-windows.png` 与 `tray-windows@2x.png`：品牌蓝灰圆角底（`#6c798d`）+ 暖白纸张色机器人（`#f7f1ea`，即 app 图标的主色）的中间调配色，确保在浅色托盘面板和深色任务栏上都清晰可辨（此前的纯白剪影在浅色背景下几乎不可见）。macOS 托盘图标 `tray.png`/`tray@2x.png` 是黑色 template 图，由系统自动重着色，不受该命令影响。

FloatNote 不为 DMG 设置品牌卷图标。`npm run tauri build` 会通过 `scripts/tauri.mjs` 启动 Tauri；在 macOS 上，该包装器只拦截 Tauri `create-dmg` 对 `.VolumeIcon.icns` 的启用操作并移除该文件，因此下载的 DMG 和挂载卷使用 macOS 系统默认图标，DMG 内及安装后的 App 继续使用上述应用图标。GitHub Release 必须设置 `tauriScript: npm run tauri`，以确保签名和公证之前已经应用该行为。

使用与目标平台匹配的 Node 22.19+ 和 Rust toolchain，执行：

```bash
npm ci
npm run tauri build
```

Tauri 的 `beforeBuildCommand` 只构建前端；Rig Agent 静态链接进 Rust 主程序，内置 Skills 作为普通 resources 打包。

## 本地签名与 CI 差异

`src-tauri/tauri.conf.json` 保留 `signingIdentity: "-"`，因此没有发布 secrets 的本地构建仍使用 ad-hoc 签名。CI 导入 Developer ID 证书后设置的 `APPLE_SIGNING_IDENTITY` 会覆盖该值，并触发正式签名与公证。

应用不再申请 JIT 或 unsigned executable memory entitlement。修改 Rig、TLS、Agent resources 或签名配置后，应通过新的 Draft 构建重新执行 Apple 公证验证。

## 应用内更新与一次性密钥配置

应用由主窗口统一协调更新：启动 10 秒后检查一次，以后每 4 小时检查，设置 → 通用 → 应用更新可手动检查和安装。后台检查失败保持安静，下载必须经用户确认。Rust 持有更新包并通过官方 Updater 验签，下载后检查 Agent 是否空闲，阻止新的 Agent 请求，前端暂停编辑并等待保存；未保存内容、写盘错误或冲突未解决时拒绝安装并解除锁。Windows 安装器会退出应用，macOS 安装后显式重启。更新不主动删除笔记、配置或聊天历史，但未来数据格式迁移仍须单独设计兼容与备份。

尚无更新器的旧安装需要手动安装一次带更新器的版本。无公钥的本地构建显示“此构建尚未启用在线更新”，不访问更新服务。

先在本机生成长期使用的更新密钥，私钥不要放进仓库。以下命令会交互式询问密码；请在密码管理器中备份私钥和密码：

```bash
mkdir -p "$HOME/.tauri"
npm run tauri signer generate -- -w "$HOME/.tauri/floatnote-updater.key"
```

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `FLOATNOTE_UPDATER_PUBLIC_KEY` | `.key.pub` 文件的完整内容，不是路径，也不需要再次 Base64 编码 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | `.key` 文件的完整内容 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成私钥时设置的密码 |

也可用已登录的 GitHub CLI，通过标准输入上传文件，不把私钥写入命令参数：

```bash
gh variable set FLOATNOTE_UPDATER_PUBLIC_KEY < "$HOME/.tauri/floatnote-updater.key.pub"
gh secret set TAURI_SIGNING_PRIVATE_KEY < "$HOME/.tauri/floatnote-updater.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

发布 job 将公钥通过 `FLOATNOTE_UPDATER_PUBLIC_KEY` 编译进应用；没有公钥时发布预检失败。本项目对最终归档手动执行 `tauri signer sign`，因此未开启 `createUpdaterArtifacts`，以免 macOS 公证后重建归档导致自动生成的签名失效。私钥仅出现在签名步骤。发布清单脚本验证签名内的 key ID 与公钥一致，完整密码学验签由客户端插件执行。

不要每次发版生成新密钥。老版本只信任编译时的公钥，轮换需要旧密钥签署过渡版本；丢失私钥会破坏已有客户端的升级路径。

## 发布更新清单

1. 推送新版本标签，等待 macOS 双架构和 Windows x86_64 构建全部通过，检查 Draft 中三平台包及 `.sig`。
2. 完成安装与功能验收后，按发布目标将 Draft 公开为 Prerelease 或正式 Release。
3. `publish-update.yml` 的 `release: published` 事件下载签名，检查三平台包可公开访问、签名 key ID 匹配，然后以一次 Git 提交更新 `updates` 分支的更新清单。Prerelease 写入 `preview.json`；正式 Release 写入 `stable.json`，并在版本更新时同步推进 `preview.json`，让已有预览客户端能够迁移到正式版本，但不会用较旧的正式版覆盖更新的预览版。
4. 正式客户端固定读取 `https://raw.githubusercontent.com/nanshine/FloatNote/updates/stable.json`。仓库及 Release 资产必须可公开访问，不向应用嵌入 GitHub token；如未来使用私有仓库，应迁移至公开对象存储/CDN。

清单发布失败时已有清单保持不变；修复后可手动运行 Publish update feed 并输入已经公开的标签。不要手工先改清单再上传包。GitHub 访问和缓存可能造成检查延迟，后续可迁移到自有域名/CDN。首次运行会创建 `updates` 分支；仓库规则需要允许工作流账号写入该分支。

## 更新验收

自动化测试覆盖单实例协调、网络/验签失败、保存失败阻止安装、Agent 忙碌保护、更新说明按纯文本显示，以及真实 Tauri signer 的清单格式。发布前仍须用真实包完成下列验收（开发模式不能替代安装测试）：

- 用相同公钥构建旧版 A、新版 B；在 Apple Silicon、Intel Mac 和 Windows x86_64 上从已安装 A 升级到 B。
- 检查手动/后台检查、稍后取消、下载进度、断网重试、签名错误阻止安装。
- 带未保存笔记更新，确认重启后内容、配置和聊天历史保留；模拟写入失败确认不会退出。
- Agent 运行中更新应提示等待或停止；停止并落盘后重试成功。
- Windows 检查 NSIS 退出/重启行为及安装目录权限，macOS 在 `/Applications` 中验证签名、公证和更新后首次启动。
