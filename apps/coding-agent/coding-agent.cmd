@echo off
rem coding-agent 起動（共有フォルダー用ランチャー経由）
chcp 65001 >nul
setlocal
set "LAUNCH=%~dp0..\..\launcher\launch.cmd"
if not exist "%LAUNCH%" (
  echo launcher\launch.cmd が見つかりません。
  echo   %LAUNCH%
  echo 共有フォルダー構成（launcher^/runtime^/apps）ごと配置してください。
  pause
  exit /b 1
)
pushd "%~dp0" 2>nul
call "%LAUNCH%" coding-agent %*
set "RC=%ERRORLEVEL%"
popd 2>nul
if not "%RC%"=="0" (
  echo.
  echo 終了コード: %RC%
  pause
)
exit /b %RC%
