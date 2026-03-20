# Local Desktop Test Script

快速本地验证安装版行为：

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\test_release.ps1
```

常用参数：

- 只构建不启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\test_release.ps1 -NoRun
```

- 构建 debug 版本：

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\test_release.ps1 -DebugBuild
```

- 跳过 Python 可执行文件重打，仅重编译 Tauri：

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\test_release.ps1 -SkipPythonBuild
```
