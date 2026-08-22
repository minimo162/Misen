@echo off
rem coding-agent 直接起動（開発・スタンドアロン配布用。同期なし）
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if not exist "%HERE%dist\index.js" (
  echo dist\index.js がありません。先に npm run build を実行してください。
  pause
  exit /b 1
)
if exist "%HERE%runtime\node.exe" set "NODE=%HERE%runtime\node.exe"
if not defined NODE if exist "%HERE%..\..\runtime\node-v22-win-x64\node.exe" set "NODE=%HERE%..\..\runtime\node-v22-win-x64\node.exe"
if not defined NODE for /d %%D in ("%HERE%..\..\runtime\node-*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"
if not defined NODE set "NODE=node"
pushd "%HERE%" 2>nul
"%NODE%" "dist\index.js" %*
set "RC=%ERRORLEVEL%"
popd 2>nul
exit /b %RC%
