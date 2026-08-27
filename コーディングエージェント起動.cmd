@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0"
set "LAUNCHER=%ROOT%launcher\launch.cmd"

if not exist "%LAUNCHER%" (
  echo launcher\launch.cmd が見つかりません。
  echo 配布フォルダーのルートから実行してください。
  pause
  exit /b 1
)

if "%~1"=="" goto default_workspace
set "WORKSPACE_ATTR="
for %%I in ("%~1") do set "WORKSPACE_ATTR=%%~aI"
if not defined WORKSPACE_ATTR goto invalid_workspace
if /i not "%WORKSPACE_ATTR:~0,1%"=="d" goto invalid_workspace
set "WORKSPACE=%~f1"
shift
goto collect_args

:default_workspace
for %%I in ("%USERPROFILE%\Documents\エージェント作業場") do set "WORKSPACE=%%~fI"
set "WORKSPACE_ATTR="
for %%I in ("%WORKSPACE%") do set "WORKSPACE_ATTR=%%~aI"
if defined WORKSPACE_ATTR if /i "%WORKSPACE_ATTR:~0,1%"=="d" goto collect_args
if defined WORKSPACE_ATTR goto workspace_create_failed
mkdir "%WORKSPACE%" 2>nul
set "WORKSPACE_ATTR="
for %%I in ("%WORKSPACE%") do set "WORKSPACE_ATTR=%%~aI"
if not defined WORKSPACE_ATTR goto workspace_create_failed
if /i not "%WORKSPACE_ATTR:~0,1%"=="d" goto workspace_create_failed

:collect_args
set "FORWARD_ARGS="
:collect_args_loop
if "%~1"=="" goto invoke_launcher
set "FORWARD_ARGS=%FORWARD_ARGS% %1"
shift
goto collect_args_loop

:invalid_workspace
echo 指定された workspace フォルダーが見つからないか、フォルダーではありません。
echo   %~1
pause
exit /b 1

:workspace_create_failed
echo 作業フォルダーを作成できません。
echo   %WORKSPACE%
pause
exit /b 1

:invoke_launcher
call "%LAUNCHER%" coding-agent --workspace "%WORKSPACE%"%FORWARD_ARGS%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo coding-agent の起動に失敗しました。終了コード: %RC%
  pause
)
exit /b %RC%
