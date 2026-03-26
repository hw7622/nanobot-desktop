@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":18791 .*LISTENING"') do (
  exit /b 0
)
start "" /B C:\Python313\pythonw.exe .\run_backend.py
