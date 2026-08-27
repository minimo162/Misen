@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set "DEMO_ROOT=%~dp0"
for %%I in ("%DEMO_ROOT%..\..\apps\coding-agent\coding-agent.cmd") do set "AGENT=%%~fI"
for %%I in ("%DEMO_ROOT%..\..\apps\coding-agent\config.flex.json") do set "CONFIG=%%~fI"
for %%I in ("%DEMO_ROOT%workspace") do set "WORKSPACE=%%~fI"

if not exist "%AGENT%" (
  echo coding-agent.cmd が見つかりません。
  echo   %AGENT%
  pause
  exit /b 1
)
if not exist "%CONFIG%" (
  echo flex 設定ファイルが見つかりません。
  echo   %CONFIG%
  pause
  exit /b 1
)
set "WORKSPACE_ATTR="
for %%I in ("%WORKSPACE%") do set "WORKSPACE_ATTR=%%~aI"
if not defined WORKSPACE_ATTR goto missing_demo_workspace
if /i not "%WORKSPACE_ATTR:~0,1%"=="d" goto missing_demo_workspace
goto run_demo

:missing_demo_workspace
echo デモ workspace フォルダーが見つかりません。
echo   %WORKSPACE%
pause
exit /b 1

:run_demo
call "%AGENT%" --config "%CONFIG%" --workspace "%WORKSPACE%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo デモの起動に失敗しました。終了コード: %RC%
  pause
)
exit /b %RC%
