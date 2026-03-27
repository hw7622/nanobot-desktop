# Nanobot Desktop

`desktop/` 是面向桌面产品化的子项目。当前已经具备一个可打包的 Windows 桌面壳：内置后端、静态配置界面、`gateway` 启停控制，以及面向安装版的资源打包链路。

## 已完成

- 本地控制后端：配置 API、schema、skills 清单、日志读取
- 静态控制台 UI：AI、渠道、MCP、Skills、运行控制
- 桌面壳：Tauri 启动后自动拉起打包进安装包的 backend/runtime
- 微信渠道：桌面壳已切到官方内置微信渠道，不再依赖独立微信插件 API / 桥接
- 安装包：可生成 `NSIS` 和 `MSI`
- 自动更新 MVP：UI 已有手动“检查更新 / 安装更新”入口，Rust 侧已接入 updater 命令
- GitHub Release 流程：已补 `publish-desktop.yml` 工作流和 updater 配置脚本

## 当前开发入口

先启动后端：

```powershell
$env:NANOBOT_DESKTOP_DATA_DIR = "D:\personal\code\nanobot-main\.desktop-data"
python desktop/run_backend.py
```

然后在浏览器打开：

```text
http://127.0.0.1:18791
```

如果已经安装 Tauri CLI，也可以直接在 `desktop/` 目录运行：

```powershell
npm run dev
```

## 打包

先构建 Python 侧可执行文件：

```powershell
python desktop\build_backend.py
python desktop\build_runtime.py
```

再构建桌面壳：

```powershell
cd desktop\src-tauri
cargo tauri build
```

## 目录

- `backend/nanobot_desktop_backend/`: 配置 API、schema 和 gateway 进程控制
- `ui/`: 静态控制台界面
- `src-tauri/`: Tauri 桌面壳与 updater 命令
- `scripts/prepare_release_config.py`: CI 中注入真实 updater 配置

## 微信渠道说明

当前桌面端已经直接接入官方内置微信渠道：

- 核心实现：`nanobot/channels/weixin.py`
- 桌面壳接线：`desktop/backend/nanobot_desktop_backend/weixin_manager.py`

桌面端当前不再依赖：

- 独立微信插件目录
- 桌面壳侧插件 API 启停
- 桥接进程启停

微信相关状态由桌面后端直接管理，前端只保留：

- 扫码登录
- 退出登录
- 渠道启用/停用
- 运行态 / 会话 / 上下文等状态展示

## 自动更新接入说明

当前默认更新源预留为你的 fork：

```text
https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json
```

Tauri 2 的 updater 需要签名，且无法关闭校验。官方要求：

- 生成一对公钥 / 私钥
- 公钥写入 `tauri.conf.json`
- 构建时通过环境变量提供私钥 `TAURI_SIGNING_PRIVATE_KEY`
- 打开 `createUpdaterArtifacts: true` 后，Windows 会产出安装包及对应 `.sig` 文件

## 你现在需要在 GitHub 做的事

1. 生成 updater 签名密钥

```powershell
cargo tauri signer generate -w ~/.tauri/nanobot-desktop.key
```

2. 打开生成出来的两个文件

- 私钥：保存到 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
- 如果你设置了密码：保存到 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- 公钥内容：保存到 GitHub Secret `DESKTOP_UPDATER_PUBKEY`

3. 确认仓库 Actions 权限允许写 `contents`

4. 进入 GitHub Actions，手动运行工作流：

```text
Publish Desktop
```

工作流会做这些事：

- 安装 Python 依赖和 PyInstaller
- 构建 `nanobot-desktop-backend.exe` 与 `nanobot-runtime.exe`
- 把真实公钥写入 `desktop/src-tauri/tauri.conf.json`
- 生成带签名的安装包
- 创建 `desktop-v__VERSION__` 格式的 GitHub Release
- 上传安装包、签名文件和 `latest.json`

## 当前代码行为

- 如果没有注入 `NANOBOT_DESKTOP_UPDATER_PUBKEY`，桌面 UI 会明确提示“未配置 updater 公钥”
- 本地开发构建仍保持 `createUpdaterArtifacts: false`，避免你平时调试时被签名流程卡住
- CI 发布时才会通过脚本把 updater 配置切换成正式发布模式

## 当前阶段已验证

- `/api/bootstrap` 正常返回 schema、配置、skills 与状态
- `/api/config` 可写回配置文件
- `gateway` 启停 API 已打通
- 桌面程序启动后可自动拉起内置 backend
- `cargo tauri build --debug` 可通过
- `cargo tauri build` 可通过
- 接入 updater 后，`debug` / `release` 桌面程序仍可启动并通过 `/api/health`

## 本阶段限制

- GitHub Actions 发版链路已经跑通过；后续发新版时注意同步递增桌面版本号，避免重复 tag
- 当前 release workflow 先做 Windows；macOS 发布流后续再补
- 目前主要验证的是 Windows 路径

