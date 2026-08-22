@echo off
rem ローカルLLMサーバー起動 (OpenAI互換API: http://127.0.0.1:11434/v1)
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "SERVER=%ROOT%runtime\llama-cpp\llama-server.exe"
set "MODEL=%ROOT%runtime\models\Qwen3.8-27B-UD-IQ3_XXS.gguf"
if not exist "%SERVER%" (
  echo runtime\llama-cpp\llama-server.exe がありません。scripts\get-llama.ps1 を実行してください。
  pause
  exit /b 1
)
if not exist "%MODEL%" (
  echo モデルファイルがありません。scripts\get-llama.ps1 を実行してください。
  pause
  exit /b 1
)
echo 起動中: http://127.0.0.1:11434/v1  (停止は Ctrl+C)
"%SERVER%" -m "%MODEL%" --host 127.0.0.1 --port 11434 -c 8192 --jinja %*
pause
