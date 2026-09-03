@echo off
chcp 65001 >nul
rem Enterprise Misen user entry point (the only file a user double-clicks). UTF-8 without BOM.
rem Never runs from the share: the verified local copy under %LOCALAPPDATA%Misen is started instead.
rem Drop a folder onto this file to use it as the workspace. ASCII-only comments: cmd.exe mis-parses
rem multi-byte text in rem lines, so Japanese appears only in echo lines after chcp 65001.
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0"
set "MANIFEST=%ROOT%_misen\manifest.json"
if not exist "%MANIFEST%" (
  echo _misen\manifest.json が見つかりません。
  echo   %MANIFEST%
  echo 管理者に配布物の再公開を依頼してください。
  goto fail
)
rem Read "current" from the manifest with PowerShell; the launcher of that version is the one to run.
set "CURRENT="
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -LiteralPath '%MANIFEST%' -Raw -Encoding UTF8 | ConvertFrom-Json).current"`) do set "CURRENT=%%V"
if not defined CURRENT (
  echo _misen\manifest.json から有効な版を読み取れませんでした。
  echo 管理者に配布物の再公開を依頼してください。
  goto fail
)
set "PS1=%ROOT%_misen\versions\%CURRENT%\launcher\launch.ps1"
if not exist "%PS1%" (
  echo 有効な版 %CURRENT% の launcher\launch.ps1 が見つかりません。
  echo   %PS1%
  echo 管理者に配布物の再公開を依頼してください。
  goto fail
)

set "WORKSPACE_ARG="
if "%~1"=="" goto run
set "FIRST_ATTR="
for %%I in ("%~1") do set "FIRST_ATTR=%%~aI"
if not defined FIRST_ATTR goto run
if /i not "%FIRST_ATTR:~0,1%"=="d" goto run
set "WORKSPACE_ARG=-Workspace "%~f1""
shift

:run
set "FORWARD="
:collect
if "%~1"=="" goto invoke
set "FORWARD=%FORWARD% %1"
shift
goto collect

:invoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -ShareRoot "%ROOT%." %WORKSPACE_ARG%%FORWARD%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0
if "%RC%"=="2" (
  echo.
  echo LLM 接続設定を記入して保存してから、もう一度 Misen起動.cmd をダブルクリックしてください。
  goto fail
)
echo.
echo Misen の起動に失敗しました。終了コード: %RC%
:fail
if not defined MISEN_NO_PAUSE pause
exit /b 1
