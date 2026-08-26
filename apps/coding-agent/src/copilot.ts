import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig } from './config'

type WsLike = {
  addEventListener(type: string, cb: (ev: { data: unknown }) => void, options?: { once: boolean }): void
  send(data: string): void
  close(): void
}

interface CdpTarget {
  id?: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

export interface CopilotSettings {
  url: string
  cdpPort: number
  reuseExistingEdge: boolean
  maxPromptChars: number
  pollIntervalMs: number
  responseTimeoutSec: number
  stallTimeoutSec: number
  displayMode: 'minimized' | 'foreground'
  endMarker: string
  agentMode: boolean
  profileName?: string
  modelPriority: string[]
}

export interface ResponseCompletionSample {
  observedAtMs: number
  text: string
  generating: boolean
  copyEnabled: boolean
}

export interface ResponseCompletionState {
  stableText: string | null
  stableSinceMs: number | null
}

export function normalizeCopilotEditorText(value: string): string {
  // Lexical inserts these caret markers at Input.insertText chunk boundaries.
  // They are DOM implementation details and are not part of the submitted text.
  return value.replace(/[\u200B\u200C]/gu, '')
}

export interface CopilotResponseCandidate {
  text: string
  bottom: number
  order: number
  copyEnabled: boolean
}

export interface CopilotStopCandidate {
  label: string
  selector: string
}

export interface CopilotCopyCandidate {
  label: string
  testId: string
  inResponseToolbar: boolean
  inCodeBlock: boolean
  disabled: boolean
  ariaDisabled: boolean
}

export interface CopilotVisibleSessionState {
  sessionId: string
  marker: string
  markerMatches: boolean
  pid: number | null
  cdpPort: number
  url: string
  title: string
  inputReady: boolean
  responseCount: number
  latestResponseLength: number
  generating: boolean
  copyEnabled: boolean
}

interface CdpProcessInfo {
  type?: unknown
  id?: unknown
}

export function selectBrowserProcessId(processInfo: unknown): number | null {
  if (!Array.isArray(processInfo)) return null
  const browser = processInfo.find((item): item is CdpProcessInfo => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as CdpProcessInfo
    return String(candidate.type ?? '').toLowerCase() === 'browser'
      && typeof candidate.id === 'number'
      && Number.isSafeInteger(candidate.id)
      && candidate.id > 0
  })
  return browser && typeof browser.id === 'number' ? browser.id : null
}

export const RESPONSE_STABILITY_MS = 1000
export const VISIBLE_SESSION_MARKER_PREFIX = 'company-apps-coding-agent:'

export function makeVisibleSessionMarker(sessionId: string): string {
  const normalized = sessionId.trim()
  if (!/^[a-z0-9_-]{6,80}$/i.test(normalized)) throw new Error('表示セッションIDが不正です')
  return VISIBLE_SESSION_MARKER_PREFIX + normalized
}

export function visibleSessionMarkerMatches(sessionId: string, marker: string): boolean {
  return marker === makeVisibleSessionMarker(sessionId)
}

export function assertResponseDeadline(deadlineMs: number, responseTimeoutSec: number, nowMs = Date.now()): void {
  if (nowMs >= deadlineMs) throw new Error(`Copilot の応答がタイムアウトしました (${responseTimeoutSec}秒)`)
}

export function selectLatestResponseCandidate(candidates: CopilotResponseCandidate[]): CopilotResponseCandidate | null {
  const usable = candidates.filter((candidate) => candidate.text.trim().length > 0)
  usable.sort((a, b) => (a.bottom - b.bottom) || (a.order - b.order))
  return usable.length > 0 ? usable[usable.length - 1] : null
}

export function isStopGenerationControl(candidate: CopilotStopCandidate): boolean {
  const structural = /fai-SendButton__stopBackground|stopGeneratingButton|stop-button/i.test(candidate.selector)
  const semantic = /stop\s*(?:generating|response)|cancel\s*(?:generation|response)|生成を停止|応答を停止|停止する/i.test(candidate.label)
  return structural || semantic
}

export function isResponseCopyControl(candidate: CopilotCopyCandidate): boolean {
  if (candidate.disabled || candidate.ariaDisabled || candidate.inCodeBlock) return false
  if (/^CopyButtonTestId$/i.test(candidate.testId)) return true
  if (/(?:応答|回答).{0,8}コピー|コピー.{0,8}(?:応答|回答)|copy\s*(?:response|answer)|(?:response|answer)\s*copy/i.test(candidate.label)) return true
  return candidate.inResponseToolbar && /^(?:コピー|copy)$/i.test(candidate.label.trim())
}

export function updateResponseCompletionState(
  previous: ResponseCompletionState,
  sample: ResponseCompletionSample
): { state: ResponseCompletionState; ready: boolean } {
  if (sample.generating || !sample.copyEnabled || sample.text.length <= 0) {
    return { state: { stableText: null, stableSinceMs: null }, ready: false }
  }
  if (previous.stableText !== sample.text || previous.stableSinceMs === null) {
    return {
      state: { stableText: sample.text, stableSinceMs: sample.observedAtMs },
      ready: false
    }
  }
  return {
    state: previous,
    ready: sample.observedAtMs - previous.stableSinceMs >= RESPONSE_STABILITY_MS
  }
}

export function resolveCopilotSettings(cfg: AgentConfig): CopilotSettings {
  const c = cfg.copilot ?? {}
  const reuseExistingEdge = c.reuseExistingEdge === true
  const configuredPort = typeof c.cdpPort === 'number' && Number.isInteger(c.cdpPort) && c.cdpPort > 0 ? c.cdpPort : 9445
  return {
    url: c.url ?? 'https://m365.cloud.microsoft/chat/',
    // A fixed port is only honored when the user explicitly opts into attaching to an existing Edge.
    // The normal path allocates a loopback port for an Edge process owned by this client.
    cdpPort: reuseExistingEdge ? configuredPort : 0,
    reuseExistingEdge,
    maxPromptChars: c.maxPromptChars ?? 120000,
    pollIntervalMs: Math.max(500, c.pollIntervalMs ?? 900),
    responseTimeoutSec: c.responseTimeoutSec ?? 300,
    stallTimeoutSec: c.stallTimeoutSec ?? 120,
    displayMode: c.displayMode === 'foreground' ? 'foreground' : 'minimized',
    endMarker: c.endMarker ?? 'AGENT_END',
    agentMode: c.agentMode === true,
    profileName: c.profileName,
    modelPriority: Array.isArray(c.modelPriority)
      ? c.modelPriority.filter((s) => s && s.trim())
      : ['GPT 5.6 Think Deeper', 'Opus', 'Think Deeper']
  }
}
const VISIBLE_JS = `const __vis=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};`
const DOCS_JS = `const __docs=[];const __seenRoots=new Set();const __addRoot=r=>{if(!r||__seenRoots.has(r))return;__seenRoots.add(r);__docs.push(r);let all=[];try{all=Array.from(r.querySelectorAll('*'));}catch(e){}for(const el of all){try{if(el.shadowRoot)__addRoot(el.shadowRoot);}catch(e){}try{if((el.tagName||'').toLowerCase()==='iframe'&&el.contentDocument)__addRoot(el.contentDocument);}catch(e){}}};__addRoot(document);`

const INPUT_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ ready: true, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href });
})()`

export const COPILOT_SCREEN_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  let input = null;
  for (const d of __docs) { input = sels.map(s => ({ s, el: d.querySelector(s) })).find(x => __vis(x.el)); if (input) break; }
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button,[role="button"],a')));
  const responseSelectors = ['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseRootSelectors = ['[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][class*="CopilotMessage" i]','[data-testid="copilot-message-div"]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseSelectorText = responseSelectors.join(',');const responseRootSelectorText=responseRootSelectors.join(',');
  const responseRoot = node => {try{return node.closest(responseRootSelectorText)||node;}catch(e){return node;}};
  const topBottom = node => {const rect=node.getBoundingClientRect();let bottom=Number(rect.bottom)||0;let win=node.ownerDocument&&node.ownerDocument.defaultView;try{while(win&&win!==win.parent&&win.frameElement){bottom+=win.frameElement.getBoundingClientRect().top;win=win.parent;}}catch(e){}return bottom;};
  const controlLabel = el => [el.getAttribute('aria-label'),el.title,el.getAttribute('data-testid'),el.getAttribute('data-automation-id'),el.id,el.className,el.innerText,el.textContent].filter(Boolean).join(' ').trim();
  const enabledCopy = el => {const label=[el.getAttribute('aria-label'),el.title,el.innerText,el.textContent].filter(Boolean).join(' ').trim();const testId=el.getAttribute('data-testid')||'';let inCode=false,inToolbar=false;try{inCode=!!el.closest('pre,code,[data-testid*="code" i]');inToolbar=!!el.closest('[role="toolbar"],.fai-CopilotMessage__actions,[data-testid="CopyButtonContainerTestId"]');}catch(e){}const identity=/^CopyButtonTestId$/i.test(testId)||/(?:応答|回答).{0,8}コピー|コピー.{0,8}(?:応答|回答)|copy\\s*(?:response|answer)|(?:response|answer)\\s*copy/i.test(label)||(inToolbar&&/^(?:コピー|copy)$/i.test(label));return __vis(el)&&!inCode&&identity&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';};
  const copyForResponse = sourceNode => {
    const ownRoot=responseRoot(sourceNode);let scope=ownRoot;
    for(let depth=0;scope&&depth<6;depth++){
      let others=[];try{others=Array.from(scope.querySelectorAll(responseSelectorText)).filter(el=>responseRoot(el)!==ownRoot);}catch(e){}
      if(others.length>0)break;
      let controls=[];try{controls=Array.from(scope.querySelectorAll('button,[role="button"],span[role="button"]'));}catch(e){}
      if(controls.some(enabledCopy))return true;
      if(scope.tagName&&/^(MAIN|BODY)$/.test(scope.tagName))break;
      scope=scope.parentElement;
    }
    return false;
  };
  const responseCandidates=[];const seenResponses=new Set();let responseOrder=0;
  for(const d of __docs)for(const selector of responseSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const node of nodes){const root=responseRoot(node);if(seenResponses.has(root)||!__vis(node))continue;const text=((node.innerText||'')||(node.textContent||'')).trim();if(!text)continue;seenResponses.add(root);responseCandidates.push({text,bottom:topBottom(root),order:responseOrder++,copyEnabled:copyForResponse(node)});}}
  const stopSelectors=['.fai-SendButton__stopBackground','[data-testid="stopGeneratingButton"]','[data-testid="stop-button"]','[aria-label*="Stop"]','[aria-label*="停止"]','[aria-label*="Cancel"]','[aria-label*="キャンセル"]','[data-testid*="stop" i]'];
  const stopCandidates=[];const seenStops=new Set();
  for(const d of __docs)for(const selector of stopSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const item of nodes){let el=item;try{el=item.closest('button,[role="button"],a')||item;}catch(e){}if(seenStops.has(el)||!__vis(el))continue;seenStops.add(el);stopCandidates.push({label:(controlLabel(el)+' '+controlLabel(item)).trim(),selector});}}
  const signIn = buttons.find(el => __vis(el) && /sign\\s*in|log\\s*in|サインイン|ログイン/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  return JSON.stringify({ inputReady: !!input, stopCandidates, responseCandidates, signinRequired, url, title: String(document.title || ''), windowName: String(window.name || ''), sessionMarker: String(document.documentElement.getAttribute('data-company-apps-session') || '') });
})()`

const FRESH_CHAT_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(新しいチャット|New chat)$/i.test(label)) score += 1000;
    else if (/新しいチャット|New chat/i.test(label)) score += 400;
    else if (/チャット|chat/i.test(label)) score += 80;
    if (/その他|履歴|検索|ライブラリ|more|history|search|library/i.test(label)) score -= 300;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    candidates.push({ el: b, label, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) { candidates[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`

export const COPILOT_CLICK_SEND_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const exclude = /stop|cancel|停止|キャンセル|regenerate|再生成|attach|添付|microphone|voice|ボイス|音声|new chat|新しいチャット|clear|クリア|close|閉じる|search|検索|library|ライブラリ|file|ファイル/;
  const structural = b => b.matches('button[type="submit"],.fai-SendButton,[class*="SendButton" i],[data-testid*="send" i],[data-automation-id*="send" i]');
  const inventory = b => ({ariaLabel:b.getAttribute('aria-label')||'',title:b.title||'',testId:b.getAttribute('data-testid')||'',automationId:b.getAttribute('data-automation-id')||'',className:typeof b.className==='string'?b.className:'',type:b.getAttribute('type')||'',disabled:!!b.disabled,ariaDisabled:b.getAttribute('aria-disabled')||'',visible:__vis(b)});
  const clickable = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    const lower = label.toLowerCase();
    const identity = [lower,b.getAttribute('data-testid'),b.getAttribute('data-automation-id'),typeof b.className==='string'?b.className:''].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    if (/^(送信|send)$/i.test(label)) score += 1000;
    else if (structural(b)) score += 600;
    else if (/送信|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    if (exclude.test(identity)) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    clickable.push({ el: b, score, inventory: inventory(b) });
  }
  clickable.sort((a, b) => b.score - a.score);
  if (clickable[0]) { clickable[0].el.click(); return JSON.stringify({ clicked: true, selected:clickable[0].inventory }); }
  const inputSelectors=['#m365-chat-editor-target-element','[data-lexical-editor="true"][contenteditable]','[role="textbox"][contenteditable]'];
  let nearby=[];
  for(const d of __docs)for(const selector of inputSelectors){const input=d.querySelector(selector);if(!input)continue;let scope=input.parentElement;for(let depth=0;scope&&depth<6;depth++,scope=scope.parentElement){const found=Array.from(scope.querySelectorAll('button,[role="button"]'));if(found.length){nearby=found;break;}}if(nearby.length)break;}
  const diagnosticButtons=(nearby.length?nearby:buttons).slice(-32);
  return JSON.stringify({ clicked: false, inventory: diagnosticButtons.map(inventory) });
})()`

export const COPILOT_SEND_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const structural = b => b.matches('button[type="submit"],.fai-SendButton,[class*="SendButton" i],[data-testid*="send" i],[data-automation-id*="send" i]');
  const inventory = b => { const r=b.getBoundingClientRect(); return {ariaLabel:b.getAttribute('aria-label')||'',title:b.title||'',testId:b.getAttribute('data-testid')||'',automationId:b.getAttribute('data-automation-id')||'',className:typeof b.className==='string'?b.className:'',type:b.getAttribute('type')||'',disabled:!!b.disabled,ariaDisabled:b.getAttribute('aria-disabled')||'',visible:__vis(b),rect:{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}}; };
  const candidates = buttons.filter(b => {
    const label=(b.getAttribute('aria-label')||b.title||b.textContent||'').trim();
    return structural(b) || /^(送信|send)$/i.test(label);
  });
  const ready = candidates.find(b => __vis(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  return JSON.stringify({ready:!!ready,inventory:candidates.slice(-32).map(inventory)});
})()`

const EDITOR_LENGTH_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return String((el.textContent || '').replace(/[\\u200B\\u200C]/g, '').length);
  }
  return '-1';
})()`

const EDITOR_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ found: true, text: String(el.textContent || '').replace(/[\\u200B\\u200C]/g, ''), active: d.activeElement === el });
  }
  return JSON.stringify({ found: false, text: '', active: false });
})()`

function textMismatchDiagnostic(expected: string, actual: string): string {
  let index = 0
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++
  const start = Math.max(0, index - 12)
  const end = index + 20
  const expectedSlice = expected.slice(start, end)
  const actualSlice = actual.slice(start, end)
  const code = (value: string) => Array.from(value).map((char) => char.codePointAt(0)?.toString(16).padStart(4, '0')).join(' ')
  return `first=${index} expected=${JSON.stringify(expectedSlice)} [${code(expectedSlice)}] actual=${JSON.stringify(actualSlice)} [${code(actualSlice)}] lengths=${expected.length}/${actual.length}`
}

export interface CopilotPhaseTiming {
  connectionMs: number
  sessionCreationMs: number
  inputReadyMs: number
  modelSelectionMs: number
  prePromptReadyMs: number
  promptWriteMs: number
  baselineReadMs: number
  sendMs: number
  generationWaitMs: number
  completionRetrievalMs: number
  totalMs: number
  promptChars: number
  responseChars: number
}

const CLEAR_EDITOR_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; }
  }
  return 'ng';
})()`

const MODEL_SELECT_JS = String.raw`(async () => {
  const candidates = __CANDIDATES__;
  const switcherSelector = __SWITCHER__;
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const stripTail = s => norm(s).replace(/[…‥]|\.{3}$/g, '');
  const eq = (a,b) => a.toLowerCase() === b.toLowerCase();
  const has = (a,b) => a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  const matchesModel = (shown,cand,picked) => {
    const a = stripTail(shown); if (!a) return false;
    if (eq(a,cand) || has(a,cand)) return true;
    if (picked && (eq(a,picked) || has(a,picked))) return true;
    return a.length >= 6 && (has(cand,a) || (picked && has(picked,a)));
  };
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const primaryLabel = el => { const p=el.querySelector('.fai-CapabilityPickerMenuItem__primaryContentWrapper'); if(p)return norm(p.innerText); const c=el.querySelector('.fui-MenuItem__content > span:first-child'); if(c)return norm(c.innerText); return norm((el.innerText||'').split('\n')[0]); };
  const subTextOf = el => { const s=el.querySelector('.fai-CapabilityPickerMenuItem__subText'); return s?norm(s.innerText):''; };
  const itemSelector='[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]';
  const menuRoot=()=>{for(const d of docs){const r=d.querySelector('.fui-MenuPopover')||d.querySelector('[data-portal-node] [role="menu"]');if(r)return r;}return null;};
  const collectItems=()=>{const r=menuRoot();return r?Array.from(r.querySelectorAll(itemSelector)).filter(visible):[];};
  const collectItemsAll=()=>{const roots=docs.flatMap(d=>Array.from(d.querySelectorAll('.fui-MenuPopover, [data-portal-node] [role="menu"]'))).filter(visible);return Array.from(new Set(roots.flatMap(r=>Array.from(r.querySelectorAll(itemSelector)).filter(visible))));};
  const pressEscape=()=>{try{const o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};const t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));}catch(e){}};
  const fireEnter=el=>{try{el.focus();const o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keyup',o));return true;}catch(e){return false;}};
  const fireMenuClick=async el=>{try{const r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2,base={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy};el.dispatchEvent(new PointerEvent('pointerover',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mouseover',base));el.dispatchEvent(new PointerEvent('pointermove',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mousemove',base));try{el.focus();}catch(e){}await sleep(60);el.dispatchEvent(new PointerEvent('pointerdown',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mousedown',{...base,button:0}));el.dispatchEvent(new PointerEvent('pointerup',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mouseup',{...base,button:0}));el.dispatchEvent(new MouseEvent('click',{...base,button:0}));try{el.click();}catch(e){}return true;}catch(e){return false;}};
  const findSwitcher=()=>{for(const d of docs){let b=d.querySelector(switcherSelector);if(b&&visible(b))return b;b=Array.from(d.querySelectorAll('button[aria-haspopup="menu"]')).find(x=>visible(x)&&(/モデル/.test(x.getAttribute('aria-label')||'')||/model/i.test(x.getAttribute('aria-label')||'')));if(b)return b;}return null;};
  const labelItems=xs=>xs.map(el=>({el,label:primaryLabel(el),submenu:el.getAttribute('aria-haspopup')==='menu',testId:el.getAttribute('data-test-id')||'',checked:el.getAttribute('aria-checked')==='true'})).filter(x=>x.label);
  const isGptTrigger=x=>/^gptSubMenuModelTrigger/i.test(x.testId)||(x.submenu&&/^gpt/i.test(x.label))||(x.submenu&&has(subTextOf(x.el),'OpenAI'));
  const findHit=(xs,c)=>xs.find(x=>eq(x.label,c))||xs.find(x=>has(x.label,c))||(/^gpt/i.test(c)?xs.find(isGptTrigger):null);
  const btn=findSwitcher();
  if(!btn)return JSON.stringify({ok:true,changed:false,reason:'switcher_not_found'});
  const current=norm(btn.innerText);
  if(candidates.length&&matchesModel(current,candidates[0],''))return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:candidates[0]});
  await fireMenuClick(btn);
  let items=[];for(let i=0;i<30;i++){items=collectItems();if(items.length)break;await sleep(100);}if(items.length){await sleep(150);const a=collectItems();if(a.length)items=a;}
  if(!items.length){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'menu_not_found',current});}
  let labeled=labelItems(items),skipped=[],observedSubMenuItems=[];
  const clickAndConfirm=async(hit,cand)=>{
    const before=new Set(collectItemsAll());await fireMenuClick(hit.el);let picked=hit.label,clicked=hit.el;
    if(hit.submenu){let fresh=[];for(let i=0;i<20;i++){fresh=collectItemsAll().filter(x=>!before.has(x));if(fresh.length)break;await sleep(100);}if(fresh.length){const sub=fresh.map(el=>({el,label:primaryLabel(el)})).filter(x=>x.label);observedSubMenuItems=sub.map(x=>x.label).slice(0,16);const suffix=cand.replace(/^GPT[\s-]*[\d.]*\s*/i,'');const h=sub.find(x=>eq(x.label,cand))||sub.find(x=>has(x.label,cand))||sub.find(x=>eq(x.label,suffix))||sub.find(x=>suffix&&has(x.label,suffix))||sub.find(x=>has(cand,x.label)&&x.label.length>=4);if(!h)return{applied:false,reason:'submenu_no_match'};picked=h.label;clicked=h.el;await fireMenuClick(clicked);}}
    const timeout=hit.submenu?5000:2000,t0=Date.now();let keyboard=false;
    while(Date.now()-t0<timeout){await sleep(hit.submenu?50:100);after_loop:{}
      const after=norm((findSwitcher()||{innerText:''}).innerText);
      if(matchesModel(after,cand,picked))return{applied:true,after,picked};
      const still=menuRoot()!==null;
      if(hit.submenu&&still&&!keyboard&&(Date.now()-t0)>=800){keyboard=true;fireEnter(clicked);}
    }
    return{applied:false,reason:'confirm_failed'};
  };
  for(let pi=0;pi<candidates.length;pi++){const cand=candidates[pi],hit=findHit(labeled,cand);if(!hit){skipped.push(cand);continue;}
    if(hit.checked){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:hit.label});}
    const r=await clickAndConfirm(hit,cand);
    if(r.applied)return JSON.stringify({ok:true,changed:true,reason:'selected',before:current,after:r.after,picked:r.picked});
    pressEscape();await sleep(150);pressEscape();await sleep(700);
    const after2=norm((findSwitcher()||{innerText:''}).innerText);
    if(matchesModel(after2,cand,r.picked||''))return JSON.stringify({ok:true,changed:true,reason:'selected_late',before:current,after:after2,picked:r.picked});
  }
  pressEscape();return JSON.stringify({ok:true,changed:false,reason:'model_not_in_menu',current,tried:candidates,skipped});
})()`

export const COPILOT_CLICK_COPY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const responseSelectors=['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseRootSelectors=['[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][class*="CopilotMessage" i]','[data-testid="copilot-message-div"]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseSelectorText=responseSelectors.join(',');const responseRootSelectorText=responseRootSelectors.join(',');
  const responseRoot=node=>{try{return node.closest(responseRootSelectorText)||node;}catch(e){return node;}};
  const topBottom=node=>{const rect=node.getBoundingClientRect();let bottom=Number(rect.bottom)||0;let win=node.ownerDocument&&node.ownerDocument.defaultView;try{while(win&&win!==win.parent&&win.frameElement){bottom+=win.frameElement.getBoundingClientRect().top;win=win.parent;}}catch(e){}return bottom;};
  const labelOf=el=>[el.getAttribute('aria-label'),el.title,el.getAttribute('data-testid'),el.getAttribute('data-automation-id'),el.id,el.className,el.innerText,el.textContent].filter(Boolean).join(' ').trim();
  const enabledCopy=el=>{const label=[el.getAttribute('aria-label'),el.title,el.innerText,el.textContent].filter(Boolean).join(' ').trim();const testId=el.getAttribute('data-testid')||'';let inCode=false,inToolbar=false;try{inCode=!!el.closest('pre,code,[data-testid*="code" i]');inToolbar=!!el.closest('[role="toolbar"],.fai-CopilotMessage__actions,[data-testid="CopyButtonContainerTestId"]');}catch(e){}const identity=/^CopyButtonTestId$/i.test(testId)||/(?:応答|回答).{0,8}コピー|コピー.{0,8}(?:応答|回答)|copy\\s*(?:response|answer)|(?:response|answer)\\s*copy/i.test(label)||(inToolbar&&/^(?:コピー|copy)$/i.test(label));return __vis(el)&&!inCode&&identity&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';};
  const responses=[];const seenResponses=new Set();let order=0;
  for(const d of __docs)for(const selector of responseSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const node of nodes){const root=responseRoot(node);if(seenResponses.has(root)||!__vis(node))continue;const text=((node.innerText||'')||(node.textContent||'')).trim();if(!text)continue;seenResponses.add(root);responses.push({node:root,bottom:topBottom(root),order:order++});}}
  responses.sort((a,b)=>(a.bottom-b.bottom)||(a.order-b.order));
  const latest=responses.length?responses[responses.length-1].node:null;
  let cand=[];let scope=latest;
  for(let depth=0;scope&&depth<6;depth++){
    let others=[];try{others=Array.from(scope.querySelectorAll(responseSelectorText)).filter(el=>responseRoot(el)!==latest);}catch(e){}
    if(others.length>0)break;
    let controls=[];try{controls=Array.from(scope.querySelectorAll('button,[role="button"],span[role="button"]'));}catch(e){}
    cand=controls.filter(enabledCopy);if(cand.length)break;
    if(scope.tagName&&/^(MAIN|BODY)$/.test(scope.tagName))break;
    scope=scope.parentElement;
  }
  const labels = cand.slice(-5).map((b) => (b.getAttribute('aria-label') || b.title || b.tagName).slice(0, 40));
  if (cand.length === 0) return JSON.stringify({ clicked: false, found: 0, sample: labels });
  const last = cand[cand.length - 1];
  try { last.scrollIntoView({ block: 'center' }); } catch (e) {}
  last.click();
  return JSON.stringify({ clicked: true, found: cand.length, label: (last.getAttribute('aria-label') || '').slice(0, 40) });
})()`

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('Copilot実行はキャンセルされました')
}

class CdpConnection {
  private ws: WsLike
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(ws: WsLike) {
    this.ws = ws
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)))
  }

  static async connect(url: string, timeoutMs = 15000): Promise<CdpConnection> {
    const ctor = (globalThis as Record<string, unknown>).WebSocket as (new (url: string) => WsLike) | undefined
    if (!ctor) throw new Error('この Node.js には標準 WebSocket がありません (v22+ を使用してください)')
    const ws = new ctor(url)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 接続タイムアウト')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 接続に失敗しました')) }, { once: true })
    })
    return new CdpConnection(ws)
  }

  private onMessage(raw: string): void {
    let obj: { id?: number; error?: unknown; result?: unknown }
    try {
      obj = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof obj.id !== 'number') return
    const p = this.pending.get(obj.id)
    if (!p) return
    this.pending.delete(obj.id)
    clearTimeout(p.timer)
    if (obj.error !== undefined) p.reject(new Error(`CDP エラー: ${JSON.stringify(obj.error).slice(0, 300)}`))
    else p.resolve(obj.result)
  }

  async method(name: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 応答タイムアウト: ${name}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.ws.send(JSON.stringify({ id, method: name, params }))
    return p
  }

  async evalJs(expression: string, timeoutMs = 30000): Promise<unknown> {
    const r = await this.method(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    )
    if (r && typeof r === 'object' && 'exceptionDetails' in r && r.exceptionDetails) {
      throw new Error('JavaScript evaluation failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    }
    const rr = r as { result?: { value?: unknown } }
    return rr?.result?.value
  }

  close(): void {
    try { this.ws.close() } catch { }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('CDP 接続を切断しました'))
    }
    this.pending.clear()
  }
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return true
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).host.toLowerCase())
  } catch {
    return false
  }
}

async function devToolsUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('Edge用の空きポートを取得できませんでした'))
      })
    })
  })
}

function profileIsInUse(profileDir: string): boolean {
  if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].some((name) => fs.existsSync(path.join(profileDir, name)))) return true
  if (process.platform !== 'win32') return false
  try {
    const needle = path.resolve(profileDir).replace(/[\\/]+$/, '').toLowerCase()
    const marker = `--user-data-dir=${needle}`
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Select-Object -ExpandProperty CommandLine'
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return output.split(/\r?\n/).some((line) => {
      const normalized = line.toLowerCase().replaceAll('"', '')
      const index = normalized.indexOf(marker)
      return index >= 0 && (index + marker.length === normalized.length || /\s/.test(normalized[index + marker.length]))
    })
  } catch {
    return true
  }
}
function findEdgePath(): string {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[]
  for (const root of roots) {
    const p = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (fs.existsSync(p)) return p
  }
  throw new Error('Microsoft Edge が見つかりません。Edge をインストールしてください。')
}

export class CopilotEdgeClient {
  readonly name = 'copilot-edge'
  private s: CopilotSettings
  private cdp: CdpConnection | null = null
  private clipGranted = false
  private ownedEdgePid: number | null = null
  private visibleEdgePid: number | null = null
  private edgeProfileDir: string | null = null
  private visibleSessionId: string | null = null
  private lastTiming: CopilotPhaseTiming | null = null

  constructor(cfg: AgentConfig) {
    this.s = resolveCopilotSettings(cfg)
  }

  private remainingTimeoutMs(deadlineMs: number, maximumMs: number): number {
    if (!Number.isFinite(deadlineMs)) return maximumMs
    const remainingMs = Math.floor(deadlineMs - Date.now())
    if (remainingMs <= 0) throw new Error('Copilot response deadline exhausted')
    return Math.max(1, Math.min(maximumMs, remainingMs))
  }

  private async grantClipboard(deadlineMs = Number.POSITIVE_INFINITY): Promise<void> {
    if (this.clipGranted) return
    const ver = await (await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(this.remainingTimeoutMs(deadlineMs, 5000))
    })).json()
    const browserWs = String((ver as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '')
    if (!browserWs) throw new Error('browser WebSocket を取得できません')
    const bws = await CdpConnection.connect(browserWs, this.remainingTimeoutMs(deadlineMs, 10000))
    try {
      await bws.method('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        origin: new URL(this.s.url).origin
      }, this.remainingTimeoutMs(deadlineMs, 10000))
    } finally {
      bws.close()
    }
    this.clipGranted = true
  }

  private async refreshBrowserProcessId(deadlineMs = Number.POSITIVE_INFINITY): Promise<void> {
    this.visibleEdgePid = null
    const ver = await (await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(this.remainingTimeoutMs(deadlineMs, 5000))
    })).json()
    const browserWs = String((ver as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '')
    if (!browserWs) throw new Error('browser WebSocket を取得できません')
    const bws = await CdpConnection.connect(browserWs, this.remainingTimeoutMs(deadlineMs, 10000))
    try {
      const result = await bws.method('SystemInfo.getProcessInfo', {}, this.remainingTimeoutMs(deadlineMs, 10000)) as {
        processInfo?: unknown
      }
      const browserPid = selectBrowserProcessId(result?.processInfo)
      if (browserPid === null) throw new Error('CDPからEdgeブラウザー本体PIDを取得できませんでした')
      this.visibleEdgePid = browserPid
    } finally {
      bws.close()
    }
  }

  private stripOuterFence(t: string): string {
    let s = t.trim()
    const m = s.match(/^```[\w-]*[ \t]*\r?\n([\s\S]*)\r?\n?```\s*$/)
    if (m) s = m[1]
    return s.split('\n').filter((l) => l.trim() !== this.s.endMarker).join('\n').trim()
  }

  private async bringToFront(deadlineMs = Number.POSITIVE_INFINITY): Promise<void> {
    try {
      await this.cdpMethod('Page.bringToFront', {}, this.remainingTimeoutMs(deadlineMs, 5000))
      const pauseMs = this.remainingTimeoutMs(deadlineMs, 300)
      await sleep(pauseMs)
    } catch {}
  }

  private readSystemClipboard(deadlineMs = Number.POSITIVE_INFINITY): string {
    if (process.platform !== 'win32') return ''
    try {
      return String(execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-Clipboard -Raw'
      ], {
        encoding: 'utf8',
        timeout: this.remainingTimeoutMs(deadlineMs, 5000),
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })).trim()
    } catch {
      return ''
    }
  }

  private async finalizeAnswer(fallbackText: string, deadlineMs = Number.POSITIVE_INFINITY): Promise<string> {
    const assertWithinDeadline = (): void => {
      assertResponseDeadline(deadlineMs, this.s.responseTimeoutSec)
    }
    const sleepWithinDeadline = async (requestedMs: number): Promise<void> => {
      assertWithinDeadline()
      await sleep(this.remainingTimeoutMs(deadlineMs, requestedMs))
      assertWithinDeadline()
    }
    let baseline = ''
    try {
      await this.bringToFront(deadlineMs)
      assertWithinDeadline()
      baseline = this.readSystemClipboard(deadlineMs)
      if (!baseline) {
        await this.grantClipboard(deadlineMs)
        baseline = String(await this.evalWithReconnect('navigator.clipboard.readText()', this.remainingTimeoutMs(deadlineMs, 8000))).trim()
      }
    } catch {}
    assertWithinDeadline()
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.bringToFront(deadlineMs)
        assertWithinDeadline()
        await this.grantClipboard(deadlineMs)
        const clicked = JSON.parse(String(await this.evalWithReconnect(
          COPILOT_CLICK_COPY_JS,
          this.remainingTimeoutMs(deadlineMs, 15000)
        ))) as { clicked: boolean }
        console.log('[clip] candidates=' + JSON.stringify(clicked))
        if (clicked.clicked) {
          await sleepWithinDeadline(400 + attempt * 200)
          let clip = this.readSystemClipboard(deadlineMs)
          if (!clip || clip.trim() === baseline) {
            clip = String(await this.evalWithReconnect(
              'navigator.clipboard.readText()',
              this.remainingTimeoutMs(deadlineMs, 10000)
            ))
          } else {
            console.log('[clip] read via Windows clipboard')
          }
          assertWithinDeadline()
          const s = this.stripOuterFence(clip)
          if (s.trim().length >= 10 && s.trim() !== baseline) {
            assertWithinDeadline()
            return s
          }
        }
      } catch (err) {
        assertWithinDeadline()
        console.log('[clip] attempt ' + attempt + ' error: ' + (err as Error).message.slice(0, 80))
      }
      await sleepWithinDeadline(700)
    }
    assertWithinDeadline()
    console.log('[clip] fallback to innerText')
    const cleaned = this.cleanResponse(fallbackText)
    assertWithinDeadline()
    return cleaned
  }

  private hardenPreferences(profileDir: string): void {
    try {
      const prefPath = path.join(profileDir, 'Default', 'Preferences')
      if (!fs.existsSync(prefPath)) return
      const j = JSON.parse(fs.readFileSync(prefPath, 'utf8'))
      if (!j.session) j.session = {}
      j.session.restore_on_startup = 4
      j.session.startup_urls = []
      if (j.profile) j.profile.exit_type = 'Normal'
      fs.writeFileSync(prefPath, JSON.stringify(j), 'utf8')
    } catch {}
  }
  private chooseEdgeProfile(): string {
    const root = path.join(process.env.APPDATA ?? process.env.USERPROFILE ?? '.', 'CompanyApps', 'coding-agent')
    fs.mkdirSync(root, { recursive: true })
    const suffix = (this.s.profileName ?? 'default').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'default'
    const stable = path.join(root, suffix === 'default' ? 'edge-profile' : 'edge-profile-' + suffix)
    if (!profileIsInUse(stable)) return stable
    return fs.mkdtempSync(path.join(root, 'edge-profile-' + suffix + '-session-'))
  }

  private async ensureEdge(): Promise<void> {
    if (this.s.reuseExistingEdge) {
      if (this.s.cdpPort > 0 && await devToolsUp(this.s.cdpPort)) return
      if (this.s.cdpPort <= 0) throw new Error('既存Edge接続を再利用するには copilot.cdpPort を指定してください')
    } else {
      if (this.ownedEdgePid !== null && await devToolsUp(this.s.cdpPort)) return
      this.s.cdpPort = await findFreePort()
    }
    const userDataDir = this.edgeProfileDir ?? this.chooseEdgeProfile()
    this.edgeProfileDir = userDataDir
    this.hardenPreferences(userDataDir)
    const args = [
      `--remote-debugging-port=${this.s.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate',
      '--disable-sync',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble'
    ]
    if (this.s.displayMode === 'minimized') args.push('--window-position=-32000,-32000', '--window-size=1280,900')
    args.push(this.s.url)
    const child = spawn(findEdgePath(), args, { detached: true, stdio: 'ignore' })
    this.ownedEdgePid = child.pid ?? null
    this.visibleEdgePid = null
    child.unref()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await devToolsUp(this.s.cdpPort)) return
      await sleep(500)
    }
    const mode = this.s.reuseExistingEdge ? '指定されたEdge' : '専用Edge'
    throw new Error(`${mode}のDevTools Protocolが起動しませんでした (port=${this.s.cdpPort})。他アプリのEdgeには接続せず、専用プロファイルで再試行してください。`)
  }
  private async listTargets(): Promise<CdpTarget[]> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json`, { signal: AbortSignal.timeout(5000) })
      const raw = (await res.json()) as CdpTarget[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private async ensurePage(): Promise<void> {
    const host = (() => { try { return new URL(this.s.url).host } catch { return '' } })()
    for (let attempt = 0; attempt < 3; attempt++) {
      const targets = await this.listTargets()
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !isLocalUrl(t.url))
      const preferred = pages.find((t) => (host && t.url?.includes(host)) || t.url?.toLowerCase().includes('copilot'))
      const fallback = this.s.reuseExistingEdge ? pages.find((t) => /^https?:/i.test(t.url ?? '')) : undefined
      const picked = preferred ?? fallback
      if (picked) {
        this.cdp?.close()
        this.cdp = await CdpConnection.connect(picked.webSocketDebuggerUrl!)
        return
      }
      const created = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000)
      }).catch(() => null)
      if (!created?.ok) {
        await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
          signal: AbortSignal.timeout(5000)
        }).catch(() => null)
      }
      await sleep(2000)
    }
    throw new Error('Copilot ページ (CDP ターゲット) を取得できませんでした。')
  }

  private async assertTrustedOrigin(): Promise<void> {
    const actualRaw = String(await this.evalWithReconnect('(() => location.origin)()'))
    const u = new URL(this.s.url)
    if (u.protocol !== 'https:' || !u.host) {
      throw new Error(`copilot.url は https の絶対 URL で指定してください: ${this.s.url}`)
    }
    let actualHost = ''
    try {
      const au = new URL(actualRaw)
      if (au.protocol !== 'https:') throw new Error('not https')
      actualHost = au.host.toLowerCase()
    } catch {
      throw new Error(`Copilot の送信先が不正です: ${actualRaw}`)
    }
    if (actualHost !== u.host.toLowerCase()) {
      throw new Error(`Copilot の送信先が設定と一致しません (expected=${u.host}, actual=${actualHost})`)
    }
  }

  private async evalWithReconnect(expr: string, timeoutMs = 20000): Promise<unknown> {
    if (!this.cdp) throw new Error('Copilot ページ未接続です')
    return this.cdp.evalJs(expr, timeoutMs)
  }

  private async waitInputReady(timeoutSec: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const raw = await this.evalWithReconnect(INPUT_READY_JS, 15000)
      const state = JSON.parse(String(raw)) as { ready: boolean; url: string }
      if (/login|signin|sign-in|auth/i.test(state.url)) {
        throw new Error('Copilot へのサインインが必要です。Edge ウィンドウでサインインしてから再実行してください。')
      }
      if (state.ready) return
      await sleep(350)
      throwIfAborted(signal)
    }
    throw new Error('Copilot の入力欄が準備できませんでした (タイムアウト)。')
  }

  private async freshChat(): Promise<void> {
    const raw = await this.evalWithReconnect(FRESH_CHAT_JS)
    if (!(JSON.parse(String(raw)) as { clicked: boolean }).clicked) {
      await this.cdpMethod('Page.navigate', { url: this.s.url })
      await sleep(3000)
    } else {
      await sleep(450)
    }
  }

  private async stampVisibleSessionMarker(sessionId: string): Promise<void> {
    const marker = makeVisibleSessionMarker(sessionId)
    const result = await this.evalWithReconnect(`(() => { const marker = ${JSON.stringify(marker)}; window.name = marker; document.documentElement.setAttribute('data-company-apps-session', marker); return JSON.stringify({ windowName: window.name, sessionMarker: document.documentElement.getAttribute('data-company-apps-session') }); })()`)
    const stamped = JSON.parse(String(result)) as { windowName?: string; sessionMarker?: string }
    if (stamped.windowName !== marker || stamped.sessionMarker !== marker) throw new Error('Copilot表示タブへセッション識別子を設定できませんでした')
  }

  async prepareVisibleSession(sessionId: string): Promise<CopilotVisibleSessionState> {
    makeVisibleSessionMarker(sessionId)
    await this.ensureEdge()
    await this.ensurePage()
    await this.refreshBrowserProcessId()
    await this.cdpMethod('Page.navigate', { url: this.s.url })
    await sleep(3000)
    await this.waitInputReady(120)
    await this.assertTrustedOrigin()
    this.visibleSessionId = sessionId
    await this.stampVisibleSessionMarker(sessionId)
    await this.bringToFront()
    return this.inspectVisibleSession(sessionId)
  }

  async inspectVisibleSession(sessionId: string): Promise<CopilotVisibleSessionState> {
    const expectedMarker = makeVisibleSessionMarker(sessionId)
    if (!this.cdp) throw new Error('Copilot表示タブは準備されていません')
    const raw = await this.evalWithReconnect(COPILOT_SCREEN_STATE_JS, 15000)
    const parsed = JSON.parse(String(raw)) as {
      inputReady?: boolean
      responseCandidates?: CopilotResponseCandidate[]
      stopCandidates?: CopilotStopCandidate[]
      url?: string
      title?: string
      windowName?: string
      sessionMarker?: string
    }
    const responses = parsed.responseCandidates ?? []
    const latest = selectLatestResponseCandidate(responses)
    const marker = String(parsed.sessionMarker ?? '')
    return {
      sessionId,
      marker,
      markerMatches: marker === expectedMarker && String(parsed.windowName ?? '') === expectedMarker,
      pid: this.visibleEdgePid,
      cdpPort: this.s.cdpPort,
      url: String(parsed.url ?? ''),
      title: String(parsed.title ?? ''),
      inputReady: parsed.inputReady === true,
      responseCount: responses.length,
      latestResponseLength: latest?.text.length ?? 0,
      generating: (parsed.stopCandidates ?? []).some(isStopGenerationControl),
      copyEnabled: latest?.copyEnabled === true
    }
  }

  private async cdpMethod(name: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<void> {
    if (!this.cdp) throw new Error('Copilot ページ未接続です')
    await this.cdp.method(name, params, timeoutMs)
  }

  private async editorLength(): Promise<number> {
    const raw = await this.evalWithReconnect(EDITOR_LENGTH_JS)
    const n = Number(raw)
    return Number.isFinite(n) ? n : -1
  }

  private async editorState(): Promise<{ found: boolean; text: string; active: boolean }> {
    const raw = await this.evalWithReconnect(EDITOR_STATE_JS)
    try {
      const state = JSON.parse(String(raw)) as { found?: boolean; text?: string; active?: boolean }
      return { found: state.found === true, text: typeof state.text === 'string' ? state.text : '', active: state.active === true }
    } catch {
      return { found: false, text: '', active: false }
    }
  }

  private async insertPrompt(prompt: string): Promise<void> {
    if (prompt.length > this.s.maxPromptChars) {
      throw new Error(`依頼文が上限 ${this.s.maxPromptChars} 文字を超えています (${prompt.length} 文字)`)
    }
    let lastDirectError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.insertDirect(prompt)
        if (attempt > 1) console.log('[input] 単一Input.insertTextの再試行で成功')
        return
      } catch (err) {
        lastDirectError = (err as Error).message
        console.log(`[input] 単一Input.insertText attempt=${attempt} failed: ${lastDirectError}`)
        if (attempt < 2) await sleep(300)
      }
    }
    console.log(`[input] 単一Input.insertTextを2回確認できず、チャンク方式へフォールバック: ${lastDirectError}`)
    await this.insertByChunks(prompt)
  }

  private async insertDirect(prompt: string): Promise<void> {
    if ((await this.editorLength()) > 0) await this.clearEditor()
    await this.bringToFront()
    await this.focusEditor()
    const timeoutMs = prompt.length > 12000 ? 90000 : prompt.length > 5000 ? 60000 : 30000
    await this.cdpMethod('Input.insertText', { text: prompt }, timeoutMs)
    let final = await this.editorState()
    for (let poll = 0; poll < 12 && (!final.found || final.text !== prompt); poll++) {
      await sleep(150)
      final = await this.editorState()
    }
    if (!final.found || final.text !== prompt) throw new Error(`貼り付け後の内容不一致 (${textMismatchDiagnostic(prompt, final.text)})`)
    const send = await this.waitSendReady(6000)
    if (!send.ready) throw new Error('単一Input.insertText後も送信ボタンが有効になりませんでした')
  }

  private async insertByChunks(prompt: string): Promise<void> {
    if ((await this.editorLength()) > 0) {
      await this.clearEditor()
    }
    let pos = 0
    let chunkSize = 450
    let rebuilds = 0
    while (pos < prompt.length) {
      const chunk = prompt.slice(pos, pos + chunkSize)
      let ok = false
      for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
        const before = await this.editorState()
        if (!before.found) throw new Error('入力欄が再描画中で見つかりませんでした')
        if (!prompt.startsWith(before.text)) {
          const diagnostic = textMismatchDiagnostic(prompt, before.text)
          console.warn(`[input] DOM文字列不一致: ${diagnostic}`)
          if (rebuilds >= 2) throw new Error(`依頼文の入力内容が一致しませんでした (${diagnostic})`)
          await this.clearEditor()
          pos = 0
          rebuilds++
          break
        }
        if (before.text.length > pos) {
          pos = before.text.length
          ok = true
          break
        }
        await this.bringToFront()
        await this.focusEditor()
        await this.cdpMethod('Input.insertText', { text: prompt.slice(pos, pos + chunk.length) })
        for (let poll = 0; poll < 8; poll++) {
          await sleep(180)
          const after = await this.editorState()
          if (!after.found || !prompt.startsWith(after.text)) break
          if (after.text.length > pos) {
            pos = after.text.length
            ok = true
            break
          }
        }
        if (!ok) await sleep(250 * attempt)
      }
      if (!ok) {
        if (pos >= prompt.length) break
        if (chunkSize > 180) {
          chunkSize = Math.floor(chunkSize / 2)
          continue
        }
        if (rebuilds >= 2) {
          throw new Error(`依頼文の入力が位置 ${pos} で反映されませんでした`)
        }
        await this.clearEditor()
        pos = 0
        rebuilds++
      }
    }
    const final = await this.editorState()
    if (!final.found || !final.text.startsWith(prompt)) {
      throw new Error(`依頼文の入力を確認できませんでした (期待 ${prompt.length} / 実際 ${final.text.length})`)
    }
  }

  private async clearEditor(): Promise<void> {
    await this.focusEditor()
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await sleep(120)
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await sleep(200)
  }

  private async focusEditor(): Promise<void> {
    const js = `(() => {
      ${VISIBLE_JS}
      ${DOCS_JS}
      const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
      for (const d of __docs) for (const s of sels) {
        const el = d.querySelector(s);
        if (__vis(el)) {
          try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
          try {
            const range = d.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = d.getSelection();
            if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          } catch (e) {}
          return 'ok';
        }
      }
      return 'ng';
    })()`
    if ((await this.evalWithReconnect(js)) !== 'ok') throw new Error('入力欄にフォーカスできませんでした')
  }

  private async waitSendReady(timeoutMs: number): Promise<{ ready: boolean; inventory: unknown }> {
    const deadline = Date.now() + timeoutMs
    let latest: { ready: boolean; inventory: unknown } = { ready: false, inventory: [] }
    do {
      try {
        latest = JSON.parse(String(await this.evalWithReconnect(COPILOT_SEND_READY_JS))) as { ready: boolean; inventory: unknown }
        if (latest.ready) return latest
      } catch {}
      if (Date.now() < deadline) await sleep(150)
    } while (Date.now() < deadline)
    return latest
  }

  private async waitSendEstablished(baselineText: string, baselineInputLength: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let notReadySamples = 0
    do {
      const state = await this.readScreenState(5000)
      const inputLength = await this.editorLength()
      const ready = await this.waitSendReady(1)
      if (state.generating || (baselineText && state.text && state.text !== baselineText) || (baselineInputLength > 0 && inputLength >= 0 && inputLength <= 2)) return true
      notReadySamples = ready.ready ? 0 : notReadySamples + 1
      if (notReadySamples >= 2) return true
      if (Date.now() < deadline) await sleep(150)
    } while (Date.now() < deadline)
    return false
  }

  private async clickSend(baselineText = ''): Promise<void> {
    const ready = await this.waitSendReady(6000)
    if (!ready.ready) {
      const diagnostic = JSON.stringify(ready.inventory ?? []).slice(0, 3000)
      console.log(`[send] candidate inventory: ${diagnostic}`)
      throw new Error(`有効な送信ボタンが見つかりませんでした。候補診断: ${diagnostic}`)
    }
    const baselineInputLength = await this.editorLength()
    const raw = await this.evalWithReconnect(COPILOT_CLICK_SEND_JS)
    const result = JSON.parse(String(raw)) as { clicked: boolean; selected?: { rect?: { cx?: number; cy?: number } }; inventory?: unknown }
    if (!result.clicked) {
      const diagnostic = JSON.stringify(result.inventory ?? []).slice(0, 3000)
      console.log(`[send] candidate inventory: ${diagnostic}`)
      throw new Error(`有効な送信ボタンが見つかりませんでした。候補診断: ${diagnostic}`)
    }
    if (await this.waitSendEstablished(baselineText, baselineInputLength, 1800)) return
    const x = Number(result.selected?.rect?.cx)
    const y = Number(result.selected?.rect?.cy)
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      await this.cdpMethod('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(80)
      await this.cdpMethod('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      if (await this.waitSendEstablished(baselineText, baselineInputLength, 1800)) {
        console.log('[send] synthetic click未成立のためCDP native mouseで送信')
        return
      }
    }
    throw new Error('送信ボタン操作後も生成開始・入力消去・応答増加を確認できませんでした')
  }

  private async readScreenState(timeoutMs = 15000): Promise<{ text: string; generating: boolean; copyEnabled: boolean; signinRequired: boolean }> {
    const raw = await this.evalWithReconnect(COPILOT_SCREEN_STATE_JS, timeoutMs)
    const parsed = JSON.parse(String(raw)) as {
      responseCandidates?: CopilotResponseCandidate[]
      stopCandidates?: CopilotStopCandidate[]
      signinRequired: boolean
    }
    const latest = selectLatestResponseCandidate(parsed.responseCandidates ?? [])
    return {
      text: latest?.text ?? '',
      generating: (parsed.stopCandidates ?? []).some(isStopGenerationControl),
      copyEnabled: latest?.copyEnabled === true,
      signinRequired: parsed.signinRequired
    }
  }

  private async waitResponse(baseline: string, signal?: AbortSignal): Promise<{ answer: string; generationWaitMs: number; completionRetrievalMs: number }> {
    const startedAt = Date.now()
    const deadline = Date.now() + this.s.responseTimeoutSec * 1000
    let lastText = ''
    let lastChange = Date.now()
    let sawNewText = false
    let completionState: ResponseCompletionState = { stableText: null, stableSinceMs: null }
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const st = await this.readScreenState(Math.min(15000, remainingMs))
      if (Date.now() >= deadline) break
      if (st.signinRequired) throw new Error('Copilot へのサインインが必要です。')
      if (st.text && st.text !== baseline) {
        sawNewText = true
        if (st.text !== lastText) {
          lastText = st.text
          lastChange = Date.now()
        }
      }
      const quietFor = Date.now() - lastChange
      const completion = updateResponseCompletionState(completionState, {
        observedAtMs: Date.now(),
        text: sawNewText && st.text === lastText ? lastText : '',
        generating: st.generating,
        copyEnabled: st.copyEnabled
      })
      completionState = completion.state
      if (completion.ready) {
        const completionReadyAt = Date.now()
        // The stable response candidate is already the same visible DOM text
        // used by YakuLingo. Avoid a second copy-button/clipboard round trip
        // after the strict completion gate; retain clipboard recovery only for
        // the unexpected case where the DOM candidate cleans to an empty value.
        const visibleAnswer = this.cleanResponse(lastText)
        const answer = visibleAnswer || await this.finalizeAnswer(lastText, deadline)
        assertResponseDeadline(deadline, this.s.responseTimeoutSec)
        return {
          answer,
          generationWaitMs: completionReadyAt - startedAt,
          completionRetrievalMs: Date.now() - completionReadyAt
        }
      }
      if (!st.generating && sawNewText && quietFor > this.s.stallTimeoutSec * 1000) {
        throw new Error('Copilot の応答が停滞したため諦めました')
      }
      const sleepMs = Math.min(this.s.pollIntervalMs, deadline - Date.now())
      if (sleepMs > 0) await sleep(sleepMs)
      throwIfAborted(signal)
    }
    throw new Error(`Copilot の応答がタイムアウトしました (${this.s.responseTimeoutSec}秒)`)
  }

  private cleanResponse(text: string): string {
    return text.split('\n').filter((l) => l.trim() !== this.s.endMarker).join('\n').trim()
  }

  private async selectModel(): Promise<void> {
    if (!this.s.modelPriority || this.s.modelPriority.length === 0) return
    const js = MODEL_SELECT_JS
      .replace('__CANDIDATES__', JSON.stringify(this.s.modelPriority))
      .replace('__SWITCHER__', JSON.stringify('#gptModeSwitcher'))
    try {
      const raw = await this.evalWithReconnect(js, 30000)
      const r = JSON.parse(String(raw)) as { changed?: boolean; reason?: string; before?: string; after?: string; picked?: string; tried?: string[] }
      if (r.changed) console.log(`[model] ${r.before ?? '?'} -> ${r.after ?? r.picked ?? '?'}`)
      else if (['switcher_not_found', 'menu_not_found', 'model_not_in_menu'].includes(r.reason ?? '')) console.warn(`[model] 利用不可のためUI既定を継続: ${r.reason}`)
    } catch (err) {
      console.log(`[model] 切替スキップ(継続): ${(err as Error).message}`)
    }
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const totalStartedAt = Date.now()
    this.lastTiming = null
    throwIfAborted(signal)
    let phaseStartedAt = Date.now()
    await this.ensureEdge()
    await this.ensurePage()
    const connectionMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    await this.freshChat()
    const sessionCreationMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    await this.waitInputReady(120, signal)
    if (this.visibleSessionId) {
      await this.stampVisibleSessionMarker(this.visibleSessionId)
      await this.bringToFront()
    }
    const inputReadyMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    await this.selectModel()
    const modelSelectionMs = Date.now() - phaseStartedAt
    throwIfAborted(signal)
    phaseStartedAt = Date.now()
    await this.waitInputReady(30, signal)
    await this.assertTrustedOrigin()
    const prePromptReadyMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    await this.insertPrompt(prompt)
    const promptWriteMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    const baseline = (await this.readScreenState()).text
    const baselineReadMs = Date.now() - phaseStartedAt
    phaseStartedAt = Date.now()
    await this.clickSend(baseline)
    const sendMs = Date.now() - phaseStartedAt
    throwIfAborted(signal)
    const response = await this.waitResponse(baseline, signal)
    this.lastTiming = {
      connectionMs,
      sessionCreationMs,
      inputReadyMs,
      modelSelectionMs,
      prePromptReadyMs,
      promptWriteMs,
      baselineReadMs,
      sendMs,
      generationWaitMs: response.generationWaitMs,
      completionRetrievalMs: response.completionRetrievalMs,
      totalMs: Date.now() - totalStartedAt,
      promptChars: prompt.length,
      responseChars: response.answer.length
    }
    console.log('[copilot-timing] ' + JSON.stringify(this.lastTiming))
    return response.answer
  }

  getLastTiming(): CopilotPhaseTiming | null {
    return this.lastTiming ? { ...this.lastTiming } : null
  }

  close(): void {
    this.cdp?.close()
    this.cdp = null
  }
}
