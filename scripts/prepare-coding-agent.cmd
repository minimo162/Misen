@echo off
rem 管理者用: clone済みリポジトリを構築して共有フォルダーへ公開
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set "HERE=%~dp0"
set "PS1=%HERE%Prepare-CodingAgent.ps1"
if not exist "%PS1%" (
  echo Prepare-CodingAgent.ps1 が見つかりません。
  pause
  exit /b 1
)

set "INTERACTIVE=0"
if not "%~1"=="" goto set_destination_from_arg
set "INTERACTIVE=1"
:prompt_destination
echo.
echo coding-agent share publish
set /p "DEST=Share UNC path: "
set "DEST=%DEST:"=%"
if not defined DEST (
  echo 共有フォルダーが入力されませんでした。
  pause
  exit /b 1
)
rem ダブルクリック時は、古い配布物を削除してから最新版を再公開する。
set "ARGS=-CleanDestination"
goto run_prepare

:set_destination_from_arg
set "DEST=%~1"
shift
set "ARGS="
:collect_args
if "%~1"=="" goto run_prepare
set "ARGS=%ARGS% %1"
shift
goto collect_args

:run_prepare
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Destination "%DEST%" %ARGS%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo 配布準備に失敗しました。終了コード: %RC%
  if "%INTERACTIVE%"=="1" pause
  exit /b %RC%
)
echo.
echo 共有フォルダーへの公開が完了しました。
if "%INTERACTIVE%"=="1" pause
exit /b 0