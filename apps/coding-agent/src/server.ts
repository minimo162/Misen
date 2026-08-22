import http from 'node:http'
import path from 'node:path'
import { loadConfig, type AgentConfig } from './config'
import { runAgentTurn, type AgentIO, type TextBackend } from './agent'
import { CopilotEdgeClient } from './copilot'
import type { ChatMessage } from './llm'
import type { ToolContext } from './tools'

const PORT = Number(process.env.PORT ?? 3948)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const cfg: AgentConfig = loadConfig(argValue('--config'))
const workspaceArg = argValue('--workspace')
const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd()
const ctx: ToolContext = { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true }

const DEFAULT_SYSTEM_PROMPT =
  'あなたは社内コーディング支援エージェントです。提供されたツールでファイルの調査・編集・コマンド実行を行い、簡潔な日本語で回答してください。'

let messages: ChatMessage[] = [{ role: 'system', content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }]
let copilotBackend: TextBackend | null = null
let busy = false
const logLines: string[] = []

function getBackend(): TextBackend | undefined {
  if (cfg.provider !== 'copilot-edge') return undefined
  if (!copilotBackend) copilotBackend = new CopilotEdgeClient(cfg)
  return copilotBackend
}

const io: AgentIO = {
  print: (t) => {
    logLines.push(t)
    console.log(t)
  },
  askYesNo: async () => false
}

const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>社内コーディングエージェント</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:"Segoe UI","Hiragino Sans",sans-serif;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:#161b22;border-bottom:1px solid #30363d}
header h1{font-size:15px;font-weight:600}
.chip{font-size:11px;color:#8b949e;background:#21262d;border:1px solid #30363d;border-radius:999px;padding:3px 10px}
#reset{margin-left:auto;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer}
#reset:hover{background:#30363d}
#chat{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}
.msg{max-width:78%;padding:10px 14px;border-radius:12px;line-height:1.6;font-size:14px;white-space:pre-wrap;word-break:break-word}
.user{align-self:flex-end;background:#1f6feb;color:#fff;border-bottom-right-radius:4px}
.assistant{align-self:flex-start;background:#161b22;border:1px solid #30363d;border-bottom-left-radius:4px}
.status{align-self:flex-start;color:#8b949e;font-size:13px;display:flex;gap:8px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:#2f81f7;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
#logbox{margin-top:6px;background:#0a0d12;border:1px solid #21262d;border-radius:8px;padding:8px 10px;font-family:Consolas,monospace;font-size:11.5px;color:#7ee787;white-space:pre-wrap;max-height:180px;overflow-y:auto}
#inputbar{display:flex;gap:10px;padding:14px 20px;background:#161b22;border-top:1px solid #30363d}
textarea{flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:12px;font-size:14px;font-family:inherit;resize:none;height:64px}
textarea:focus{outline:none;border-color:#2f81f7}
button.send{background:#238636;color:#fff;border:none;border-radius:10px;padding:0 26px;font-size:14px;font-weight:600;cursor:pointer}
button.send:hover{background:#2ea043}
button.send:disabled{opacity:.45;cursor:not-allowed}
footer{padding:6px 20px 10px;font-size:11px;color:#484f58;text-align:right}
</style>
</head>
<body>
<header><h1>⌨ 社内コーディングエージェント</h1><span class="chip" id="chip-model"></span><span class="chip" id="chip-cwd"></span><button id="reset">新しいセッション</button></header>
<div id="chat"></div>
<div id="inputbar"><textarea id="q" placeholder="依頼を入力(Ctrl+Enterで送信)"></textarea><button class="send" id="send">送信</button></div>
<footer>ファイル書き込みは自動承認 / コマンド実行は設定に従う</footer>
<script>
const chat=document.getElementById('chat'),q=document.getElementById('q'),send=document.getElementById('send');
let polling=null;
function add(cls,text){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok){const e=await r.json().catch(()=>({error:r.statusText}));throw new Error(e.error||r.statusText)}return r.json()}
function startPoll(){if(polling)return;let seen=0;polling=setInterval(async()=>{try{const r=await fetch('/api/log?offset='+seen);if(!r.ok)return;const j=await r.json();for(const l of j.lines.slice(seen-seen+j.lines.length-j.lines.length)||[]){}seen=j.total;j.lines.forEach(l=>{logEl(l)})}catch(e){}},1200)}
let logBox=null;
function logEl(text){if(!logBox||!document.body.contains(logBox)){logBox=document.createElement('div');logBox.className='status';logBox.innerHTML='<span class="dot"></span>作業中<div id="logbox"></div>';chat.appendChild(logBox);chat.scrollTop=chat.scrollHeight}const lb=logBox.querySelector('#logbox');lb.textContent+=text+'\\n';lb.scrollTop=lb.scrollHeight;chat.scrollTop=chat.scrollHeight}
function stopPoll(){if(polling){clearInterval(polling);polling=null}}
send.onclick=run;
q.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))run()});
async function run(){
 const text=q.value.trim();if(!text)return;
 q.value='';add('user',text);send.disabled=true;q.disabled=true;startPoll();
 try{const r=await post('/api/turn',{message:text});stopPoll();
  if(r.logs&&r.logs.length)logEl('[完了]');
  add('assistant',r.reply||'(応答なし)');
 }catch(e){stopPoll();add('assistant','[error] '+e.message)}
 send.disabled=false;q.disabled=false;q.focus();
}
document.getElementById('reset').onclick=async()=>{await fetch('/api/reset',{method:'POST'});chat.innerHTML='';};
(async()=>{try{const i=await(await fetch('/api/info')).json();document.getElementById('chip-model').textContent=i.model;i.workspace&&((document.getElementById('chip-cwd').textContent=i.workspace))}catch(e){}})();
</script>
</body>
</html>`

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/info') {
    json(res, 200, { model: cfg.model || (cfg.provider ?? ''), provider: cfg.provider ?? 'openai', workspace })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/log') {
    const offset = Number(url.searchParams.get('offset') ?? 0)
    json(res, 200, { total: logLines.length, lines: logLines.slice(offset) })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    messages = messages.slice(0, 1)
    logLines.length = 0
    json(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/turn') {
    if (busy) { json(res, 409, { error: '別の処理を実行中です' }); return }
    let input = ''
    try { input = String((JSON.parse(await readBody(req)) as { message?: string }).message ?? '').trim() } catch {}
    if (!input) { json(res, 400, { error: 'message が空です' }); return }
    busy = true
    const startIdx = logLines.length
    try {
      const backend = getBackend()
      const result = await runAgentTurn({ cfg, messages, userInput: input, ctx, io, backend })
      messages = result.messages
      json(res, 200, { reply: result.reply || (result.aborted ? '(中断)' : ''), aborted: result.aborted, logs: logLines.slice(startIdx) })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    } finally {
      busy = false
    }
    return
  }
  res.writeHead(404); res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coding-agent web UI: http://127.0.0.1:${PORT}  (workspace=${workspace})`)
})
