# Nanobot Desktop 交接说明

## 1. 项目定位

这是基于 `nanobot` 改造的桌面增强版，目标是给非技术用户提供：

- Windows 安装包
- 自动更新
- 可视化配置 AI / MCP / Skills / 渠道
- 通过 Telegram、飞书、钉钉、Email、QQ、企业微信等渠道聊天控制电脑

当前开发方向：

- Windows 优先
- macOS 只保留后续兼容性
- 桌面端优先做“傻瓜式安装 + UI 配置 + 聊天查看”

## 2. 真实工作仓库

请始终以这个仓库为准：

- GitHub: `https://github.com/hw7622/nanobot-desktop`

本地建议路径：

- `D:\personal\code\nanobot-desktop`

不要把 `D:\personal\code\nanobot-main` 当成真实开发仓库，它只是早期沟通残留目录。

## 3. 当前已经完成的内容

- 已做出桌面子项目 `desktop/`
- 已有 Tauri 桌面壳
- 已有本地后端控制台
- 已支持配置 AI / 渠道 / MCP / Skills
- 已支持 Gateway 启停
- 已支持自动更新基础链路
- 已支持查看真实会话列表
- 已增加本地测试聊天
- 已增加 Skills 新增 / 删除
- 已增加日志轮转
- README 已改成中文优先、英文补充

## 4. 最近改动重点

### 前端 UI

- 概览页去掉了和“运行控制”重复的 Gateway 控制 / 自动更新区
- 概览页长路径不再直接显示，改成打开按钮
- 聊天页增加真实会话查看
- 聊天页修了滚动条总回顶部的问题
- 聊天区缩小会话列表宽度，放大消息区
- 聊天消息支持自动换行
- 聊天消息支持轻量格式显示
- 聊天消息支持 Markdown 图片 / 图片链接渲染

### 后端

- 新增 `desktop/backend/nanobot_desktop_backend/chat_manager.py`
- 增加会话接口、聊天接口、技能增删接口、打开目录接口
- Gateway 日志加入轮转
- Desktop 自身日志也加入轮转

### 打包

- Tauri 打包目标已经改成只走 `nsis`
- 不再走 `msi / wix / light.exe`
- `litellm` 运行所需根目录 json 已补进 runtime 打包
- `litellm` 整包数据收集已取消，避免 NSIS 因超深路径失败

## 5. 当前最重要的已知状态

### 已确认的问题链

1. 早期 runtime 缺少 `litellm` json，导致启动 Gateway 报错
2. 已修复为只补 root json 文件
3. 后续必须重新执行 `python desktop/build_runtime.py`
4. 然后再重新执行 `cargo tauri build --debug` 或正式构建

### 当前打包注意

如果本地打包失败，优先检查是不是旧 runtime 没清掉。

建议先执行：

```powershell
Get-Process | Where-Object {
  $_.ProcessName -like "*nanobot*" -or $_.ProcessName -like "*python*"
} | Stop-Process -Force
```

再清理 runtime 产物：

```powershell
Remove-Item D:\personal\code\nanobot-desktop\desktop\dist\runtime -Recurse -Force
Remove-Item D:\personal\code\nanobot-desktop\desktop\build\runtime -Recurse -Force
Remove-Item D:\personal\code\nanobot-desktop\desktop\build\runtime-spec -Recurse -Force
```

然后重新构建：

```powershell
cd D:\personal\code\nanobot-desktop
python desktop\build_runtime.py
cd desktop\src-tauri
cargo tauri build --debug
```

最终安装包看这里：

```powershell
D:\personal\code\nanobot-desktop\desktop\src-tauri\target\debug\bundle\nsis\Nanobot Desktop_0.1.0_x64-setup.exe
```

## 6. 新电脑环境准备

新电脑需要先安装：

- Git
- Python 3.11+（建议和当前一致）
- Node.js / npm
- Rust / Cargo

建议执行顺序：

```powershell
git clone https://github.com/hw7622/nanobot-desktop.git
cd nanobot-desktop
pip install -e .
cd desktop
npm install
cd ..
```

如果只是继续开发，不急着打安装包，可以先跑本地后端：

```powershell
python desktop\run_backend.py
```

然后前端桌面开发：

```powershell
cd desktop\src-tauri
cargo tauri dev
```

## 7. 和 Codex / AI 继续协作的方式

换电脑后，新开聊天时最好一次性贴这些信息：

### 建议开场说明

```text
继续处理 nanobot-desktop 项目。

真实仓库：
https://github.com/hw7622/nanobot-desktop

本地路径：
D:\personal\code\nanobot-desktop

请忽略 nanobot-main，只操作 nanobot-desktop。

先看仓库里的 HANDOFF.md，再继续当前任务。
```

### 如果要继续修构建问题

```text
当前重点先解决桌面安装包 / runtime / tauri 打包问题。
请先检查：
1. desktop/build_runtime.py
2. desktop/src-tauri/tauri.conf.json
3. 最新构建日志
```

### 如果要继续修 UI

```text
当前重点先继续优化桌面 UI。
请先检查：
1. desktop/ui/app.js
2. desktop/ui/styles.css
3. desktop/backend/nanobot_desktop_backend/app.py
4. HANDOFF.md
```

## 8. 当前还值得继续优化的点

- 聊天窗口继续打磨视觉样式
- 多会话视图进一步优化
- 渠道配置继续做“基础模式 / 高级模式”分层
- AI 配置继续简化，尽量贴近“小白只填地址 / key / 模型”
- README 继续补桌面版安装说明
- 发布流程继续验证自动更新体验

## 9. 当前重要文件

- `desktop/ui/app.js`
- `desktop/ui/styles.css`
- `desktop/ui/index.html`
- `desktop/backend/nanobot_desktop_backend/app.py`
- `desktop/backend/nanobot_desktop_backend/chat_manager.py`
- `desktop/backend/nanobot_desktop_backend/config_manager.py`
- `desktop/backend/nanobot_desktop_backend/gateway_manager.py`
- `desktop/build_runtime.py`
- `desktop/src-tauri/tauri.conf.json`
- `.github/workflows/publish-desktop.yml`

## 10. 协作原则

- 优先本地验证，不要每次都推 GitHub Actions
- 所有真实修改都放在 `nanobot-desktop`
- 如果出现构建异常，先看是不是旧产物没有清理
- 如果 UI 异常，优先检查 `app.js` 是否有前端运行时报错
- 如果 Telegram 报 `Conflict`，优先检查是否有多个 runtime 在同时运行
