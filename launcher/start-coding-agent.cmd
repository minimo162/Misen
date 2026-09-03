@echo off
rem 社内共有フォルダーから coding-agent を同期して起動する一発ランチャー
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0"
if not exist "%ROOT%launch-coding-agent.cmd" if exist "%ROOT%launcher\launch-coding-agent.cmd" set "ROOT=%ROOT%launcher\"
if not exist "%ROOT%launch-coding-agent.cmd" (
  echo launch-coding-agent.cmd が見つかりません。
  echo launcher フォルダーごと配置してください。
  pause
  exit /b 1
)

rem 引数なしなら、作業フォルダーは Documents を既定にする。
rem 別のフォルダーを使う場合は --workspace "C:\path" を渡す。
if "%~1"=="" (
  set "DEFAULT_WORKSPACE=%USERPROFILE%\Documents"
  if not exist "%DEFAULT_WORKSPACE%" set "DEFAULT_WORKSPACE=%USERPROFILE%"
  call "%ROOT%launch-coding-agent.cmd" coding-agent --workspace "%DEFAULT_WORKSPACE%"
) else (
  call "%ROOT%launch-coding-agent.cmd" coding-agent %*
)
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo coding-agent の起動に失敗しました。終了コード: %RC%
  pause
)
exit /b %RC%
