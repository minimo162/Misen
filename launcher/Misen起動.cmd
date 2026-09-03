@echo off
chcp 65001 >nul
rem Enterprise Misen user entry point (the only file a user double-clicks). UTF-8 without BOM.
rem Never runs from the share: the verified local copy under %LOCALAPPDATA%Misen is started instead.
rem Drop a folder onto this file to use it as the workspace. ASCII-only comments: cmd.exe mis-parses
rem multi-byte text in rem lines, so Japanese appears only in echo lines after chcp 65001.
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0"
set "PS1=%ROOT%launcher\launch.ps1"
if not exist "%PS1%" set "PS1=%ROOT%launch.ps1"
if not exist "%PS1%" (
  echo launcher\launch.ps1 が見つかりません。
  echo   %PS1%
  echo 共有フォルダーの Misen起動.cmd をそのままダブルクリックしてください。
  goto fail
)
if not exist "%ROOT%manifest.json" (
  echo manifest.json が見つかりません。
  echo   %ROOT%manifest.json
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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %WORKSPACE_ARG%%FORWARD%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0
echo.
echo Misen の起動に失敗しました。終了コード: %RC%
:fail
if not defined MISEN_NO_PAUSE pause
exit /b 1
