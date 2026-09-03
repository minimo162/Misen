@echo off
rem coding-agent launcher (CMD). UTF-8 no BOM. Japanese text after chcp 65001 only.
chcp 65001 >nul
setlocal
set "PS1=%~dp0launch-coding-agent.ps1"
if not exist "%PS1%" (
  echo launch-coding-agent.ps1 が見つかりません。
  echo   %PS1%
  echo launcher フォルダーをこのファイルと同じ場所に置いてください。
  pause
  exit /b 1
)
if "%~1"=="" (
  echo Usage: launch-coding-agent.cmd ^<app-name^> [args...]
  pause
  exit /b 1
)
pushd "%~dp0" 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
popd 2>nul
if not "%RC%"=="0" (
  echo.
  echo 起動に失敗しました。終了コード: %RC%
  pause
)
exit /b %RC%
