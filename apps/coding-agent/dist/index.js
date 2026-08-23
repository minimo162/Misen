"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_node_path5 = __toESM(require("node:path"));

// src/config.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var DEFAULT_CONFIG = {
  baseURL: "",
  model: "",
  provider: "copilot-edge",
  copilot: { displayMode: "foreground" }
};
function appDataConfigPath() {
  return import_node_path.default.join(process.env.APPDATA ?? process.env.USERPROFILE ?? ".", "CompanyApps", "coding-agent", "config.json");
}
function parseConfig(found) {
  const raw = JSON.parse(import_node_fs.default.readFileSync(found, "utf8"));
  const provider = raw.provider ?? "openai";
  if (provider === "openai" && (!raw.baseURL || !raw.model)) {
    throw new Error(`provider=openai \u306B\u306F baseURL / model \u304C\u5FC5\u8981\u3067\u3059: ${found}`);
  }
  return { ...raw, provider };
}
function loadConfig(explicitPath) {
  if (explicitPath) {
    if (!import_node_fs.default.existsSync(explicitPath)) throw new Error(`\u6307\u5B9A\u3055\u308C\u305F config \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${explicitPath}`);
    return parseConfig(explicitPath);
  }
  const appDataPath = appDataConfigPath();
  const candidates = [import_node_path.default.join(process.cwd(), "config.json"), appDataPath];
  const found = candidates.find((p) => import_node_fs.default.existsSync(p));
  if (found) return parseConfig(found);
  const dir = import_node_path.default.dirname(appDataPath);
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  import_node_fs.default.writeFileSync(appDataPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  console.log(`\u65E2\u5B9A\u306E\u8A2D\u5B9A\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F: ${appDataPath}`);
  return DEFAULT_CONFIG;
}
function resolveApiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  return process.env[cfg.apiKeyEnv ?? "COMPANY_LLM_API_KEY"];
}

// src/repl.ts
var import_node_readline = __toESM(require("node:readline"));

// src/llm.ts
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));
function postJson(url, body, headers, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? import_node_https.default : import_node_http.default;
    const req = mod.request(
      u,
      { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body).toString() } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      }
    );
    req.setTimeout(0);
    const abort = () => req.destroy(new Error("LLM request aborted"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject);
    req.on("close", () => signal?.removeEventListener("abort", abort));
    req.end(body);
  });
}
async function chat(cfg, messages, tools, signal) {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  const key = resolveApiKey(cfg);
  if (key) headers.authorization = `Bearer ${key}`;
  const payload = JSON.stringify({
    model: cfg.model,
    temperature: cfg.temperature ?? 0.2,
    messages,
    ...cfg.chatTemplateKwargs ? { chat_template_kwargs: cfg.chatTemplateKwargs } : {},
    ...tools.length > 0 ? { tools } : {}
  });
  const res = await postJson(url, payload, headers, signal);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM API \u30A8\u30E9\u30FC ${res.status}: ${res.text.slice(0, 400)}`);
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error("LLM API \u306E\u5FDC\u7B54\u304C JSON \u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  }
  const raw = data.choices?.[0]?.message;
  if (!raw) throw new Error("LLM API \u306E\u5FDC\u7B54\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  return {
    role: "assistant",
    content: raw.content ?? "",
    ...raw.tool_calls ? { tool_calls: raw.tool_calls } : {}
  };
}

// src/tools.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_util = __toESM(require("node:util"));

// src/processes.ts
var import_node_child_process = require("node:child_process");
var MAX_RECORDS = 24;
var MAX_OUTPUT_LINES = 400;
var records = /* @__PURE__ */ new Map();
var sequence = 0;
function makeId() {
  sequence = (sequence + 1) % 1048576;
  return `proc-${Date.now().toString(36)}-${sequence.toString(36)}`;
}
function appendLine(record, line, stream) {
  const text = line.trimEnd();
  if (!text) return;
  record.output.push(`[${stream}] ${text}`);
  while (record.output.length > MAX_OUTPUT_LINES) {
    record.output.shift();
    record.baseOffset += 1;
  }
}
function appendChunk(record, stream, chunk) {
  const combined = record.pending[stream] + chunk;
  const parts = combined.split(/\r?\n/);
  record.pending[stream] = parts.pop() ?? "";
  for (const line of parts) appendLine(record, line, stream);
}
function flushPending(record) {
  for (const stream of ["stdout", "stderr"]) {
    if (record.pending[stream]) {
      appendLine(record, record.pending[stream], stream);
      record.pending[stream] = "";
    }
  }
}
function snapshot(record) {
  return {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    label: record.label,
    ...record.url ? { url: record.url } : {},
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    tail: record.output.slice(-8),
    nextOffset: record.baseOffset + record.output.length
  };
}
function validateUrl(url) {
  if (!url) return void 0;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`url\u304C\u4E0D\u6B63\u3067\u3059: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url\u306Fhttp\u307E\u305F\u306Fhttps\u3060\u3051\u6307\u5B9A\u3067\u304D\u307E\u3059");
  }
  return parsed.toString();
}
function pruneRecords() {
  if (records.size <= MAX_RECORDS) return;
  const removable = [...records.values()].filter((record) => record.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  while (records.size > MAX_RECORDS && removable.length > 0) {
    const record = removable.shift();
    if (record) records.delete(record.id);
  }
}
function startManagedProcess(command, cwd, label, url) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command\u304C\u7A7A\u3067\u3059");
  const cleanUrl = validateUrl(url);
  const child = (0, import_node_child_process.spawn)(trimmed, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const record = {
    id: makeId(),
    command: trimmed,
    cwd,
    label: label?.trim() || trimmed.slice(0, 80),
    ...cleanUrl ? { url: cleanUrl } : {},
    child,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    output: [],
    baseOffset: 0,
    pending: { stdout: "", stderr: "" },
    requestedStop: false
  };
  records.set(record.id, record);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => appendChunk(record, "stdout", String(chunk)));
  child.stderr?.on("data", (chunk) => appendChunk(record, "stderr", String(chunk)));
  child.once("error", (error) => {
    appendLine(record, error.message, "stderr");
    if (record.status === "running") {
      record.status = "failed";
      record.finishedAt = Date.now();
    }
  });
  child.once("close", (code, signal) => {
    flushPending(record);
    if (record.status === "running") {
      record.status = record.requestedStop ? "stopped" : code === 0 ? "exited" : "failed";
      record.finishedAt = Date.now();
      record.exitCode = code;
      record.signal = signal;
    }
    pruneRecords();
  });
  pruneRecords();
  return snapshot(record);
}
function listManagedProcesses() {
  return [...records.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot);
}
function waitForClose(record, timeoutMs) {
  if (record.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    record.child.once("close", finish);
    record.child.once("error", finish);
  });
}
async function stopManagedProcess(id) {
  const record = records.get(id);
  if (!record) throw new Error(`process\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
  if (record.status !== "running") return snapshot(record);
  record.requestedStop = true;
  if (process.platform === "win32" && record.child.pid) {
    await new Promise((resolve) => {
      const killer = (0, import_node_child_process.spawn)("taskkill", ["/PID", String(record.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("close", (code) => {
        if (code !== 0) {
          try {
            record.child.kill();
          } catch {
          }
        }
        resolve();
      });
      killer.once("error", () => {
        try {
          record.child.kill();
        } catch {
        }
        resolve();
      });
    });
  } else {
    try {
      record.child.kill("SIGTERM");
    } catch {
    }
  }
  await waitForClose(record, 3e3);
  if (record.status === "running") {
    record.status = "stopped";
    record.finishedAt = Date.now();
    record.signal = "SIGTERM";
  }
  return snapshot(record);
}
function readManagedProcessLog(id, offset = 0) {
  const record = records.get(id);
  if (!record) throw new Error(`process\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${id}`);
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const start = Math.max(0, safeOffset - record.baseOffset);
  return {
    process: snapshot(record),
    lines: record.output.slice(start),
    nextOffset: record.baseOffset + record.output.length,
    truncated: safeOffset < record.baseOffset
  };
}

// src/tools.ts
var execAsync = import_node_util.default.promisify(import_node_child_process2.exec);
var IGNORED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", ".tmp"]);
var MAX_LIST = 500;
var MAX_SEARCH_RESULTS = 200;
function sha256(text) {
  return import_node_crypto.default.createHash("sha256").update(text, "utf8").digest("hex");
}
function lineDelta(before, after) {
  const beforeLines = before === "" ? [] : before.split(/\r?\n/);
  const afterLines = after === "" ? [] : after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix++;
  return {
    removedLines: Math.max(0, beforeLines.length - prefix - suffix),
    addedLines: Math.max(0, afterLines.length - prefix - suffix)
  };
}
function formatFileChangeResult(action, relativePath, before, after, count) {
  const changed = before !== after;
  const delta = lineDelta(before, after);
  const meta = {
    changed,
    status: changed ? "applied_unverified" : "no_op",
    path: relativePath,
    count,
    beforeHash: sha256(before),
    afterHash: sha256(after),
    readBack: true,
    ...delta
  };
  return [
    `${changed ? `${action}\u5B8C\u4E86` : "\u5909\u66F4\u306A\u3057"}: ${relativePath} (${count} \u7B87\u6240)`,
    `\u72B6\u614B: ${meta.status}`,
    `\u5909\u66F4\u524D\u30CF\u30C3\u30B7\u30E5: ${meta.beforeHash}`,
    `\u5909\u66F4\u5F8C\u30CF\u30C3\u30B7\u30E5: ${meta.afterHash}`,
    "\u518D\u8AAD\u8FBC: \u6210\u529F",
    `\u5DEE\u5206: +${meta.addedLines} -${meta.removedLines}`,
    `\u7D50\u679C\u30E1\u30BF\u30C7\u30FC\u30BF: ${JSON.stringify(meta)}`
  ].join("\n");
}
function parseToolResultMeta(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("\u7D50\u679C\u30E1\u30BF\u30C7\u30FC\u30BF:"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("\u7D50\u679C\u30E1\u30BF\u30C7\u30FC\u30BF:".length).trim());
  } catch {
    return null;
  }
}
var fileSnapshots = /* @__PURE__ */ new Map();
function truncate(s, max = 8e3) {
  return s.length <= max ? s : s.slice(0, max) + `
...(\u7701\u7565: \u5168${s.length}\u6587\u5B57)`;
}
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
function resolveInWorkspace(p, ctx) {
  if (!p) throw new Error("\u30D1\u30B9\u304C\u7A7A\u3067\u3059");
  const abs = import_node_path2.default.isAbsolute(p) ? import_node_path2.default.normalize(p) : import_node_path2.default.resolve(ctx.workspace, p);
  if (ctx.restrictToWorkspace && import_node_path2.default.relative(ctx.workspace, abs).startsWith("..")) {
    throw new Error(`\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5916\u306E\u30D1\u30B9\u306F\u8A31\u53EF\u3055\u308C\u3066\u3044\u307E\u305B\u3093: ${p}`);
  }
  return abs;
}
async function walk(dir, cb, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await import_promises.default.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = import_node_path2.default.join(dir, e.name);
    if (e.isDirectory()) await walk(full, cb, depth + 1);
    else if (e.isFile()) cb(full);
  }
}
var TOOL_DEFS = [
  {
    name: "list_files",
    description: "\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5185\u306E\u30D5\u30A1\u30A4\u30EB\u4E00\u89A7\u3092\u8FD4\u3059",
    kind: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u8D77\u70B9\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA (\u65E2\u5B9A: \u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u30EB\u30FC\u30C8)" },
        glob: { type: "string", description: "\u30D5\u30A1\u30A4\u30EB\u540D\u306E\u30D1\u30BF\u30FC\u30F3\u3002\u4F8B: *.ts" }
      },
      required: []
    },
    async run(args, ctx) {
      const base = args.path ? resolveInWorkspace(String(args.path), ctx) : ctx.workspace;
      const re = args.glob ? wildcardToRegExp(String(args.glob)) : null;
      const out = [];
      await walk(base, (f) => {
        if (out.length >= MAX_LIST) return;
        if (!re || re.test(import_node_path2.default.basename(f))) out.push(import_node_path2.default.relative(ctx.workspace, f).replaceAll("\\", "/"));
      });
      return out.length === 0 ? "(\u8A72\u5F53\u306A\u3057)" : truncate(out.join("\n"));
    }
  },
  {
    name: "read_file",
    description: "\u30C6\u30AD\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB\u3092\u884C\u756A\u53F7\u4ED8\u304D\u3067\u8AAD\u3080",
    kind: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u30D5\u30A1\u30A4\u30EB\u30D1\u30B9" },
        offset: { type: "number", description: "\u958B\u59CB\u884C (1\u59CB\u307E\u308A)" },
        limit: { type: "number", description: "\u8AAD\u307F\u53D6\u308A\u884C\u6570 (\u65E2\u5B9A 2000)" }
      },
      required: ["path"]
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx);
      const text = await import_promises.default.readFile(abs, "utf8");
      const lines = text.split("\n");
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.max(1, Number(args.limit ?? 2e3));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((l, i) => `${offset + i}: ${l}`).join("\n");
      return truncate(body, 1e5);
    }
  },
  {
    name: "write_file",
    description: "\u30C6\u30AD\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB\u3092\u65B0\u898F\u4F5C\u6210\u307E\u305F\u306F\u4E0A\u66F8\u304D\u3059\u308B",
    kind: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u30D5\u30A1\u30A4\u30EB\u30D1\u30B9" },
        content: { type: "string", description: "\u66F8\u304D\u8FBC\u3080\u5185\u5BB9" }
      },
      required: ["path", "content"]
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx);
      const content = String(args.content ?? "");
      if (!content.trim()) throw new Error("content \u304C\u7A7A\u3067\u3059\u3002JSON \u76F4\u5F8C\u306E\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9\u306B\u5185\u5BB9\u3092\u8A18\u8FF0\u3057\u3066\u304F\u3060\u3055\u3044");
      let before = "";
      try {
        before = await import_promises.default.readFile(abs, "utf8");
      } catch (err) {
        const e = err;
        if (e.code !== "ENOENT") throw err;
      }
      await import_promises.default.mkdir(import_node_path2.default.dirname(abs), { recursive: true });
      await import_promises.default.writeFile(abs, content, "utf8");
      const readBack = await import_promises.default.readFile(abs, "utf8");
      fileSnapshots.set(abs, { before, after: readBack, afterHash: sha256(readBack), createdAt: Date.now() });
      const result = formatFileChangeResult("\u66F8\u304D\u8FBC\u307F", import_node_path2.default.relative(ctx.workspace, abs), before, readBack, 1);
      return `${result}
\u30B5\u30A4\u30BA: ${Buffer.byteLength(readBack)} bytes`;
    }
  },
  {
    name: "edit_file",
    description: "\u30D5\u30A1\u30A4\u30EB\u5185\u306E\u6587\u5B57\u5217\u3092\u7F6E\u63DB\u3059\u308B",
    kind: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u30D5\u30A1\u30A4\u30EB\u30D1\u30B9" },
        old_string: { type: "string", description: "\u7F6E\u63DB\u5BFE\u8C61\u306E\u6587\u5B57\u5217 (\u5B8C\u5168\u4E00\u81F4)" },
        new_string: { type: "string", description: "\u7F6E\u63DB\u5F8C\u306E\u6587\u5B57\u5217" },
        replace_all: { type: "boolean", description: "\u5168\u4EF6\u7F6E\u63DB\u3059\u308B\u304B (\u65E2\u5B9A false)" }
      },
      required: ["path", "old_string", "new_string"]
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx);
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      if (!oldStr) throw new Error("old_string \u304C\u7A7A\u3067\u3059");
      const replaceAll = Boolean(args.replace_all);
      const src = await import_promises.default.readFile(abs, "utf8");
      const count = src.split(oldStr).length - 1;
      if (count === 0) throw new Error("old_string \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
      if (count > 1 && !replaceAll) throw new Error(`${count} \u4EF6\u4E00\u81F4\u3057\u307E\u3057\u305F\u3002replace_all=true \u3092\u6307\u5B9A\u3059\u308B\u304B\u5BFE\u8C61\u7BC4\u56F2\u3092\u72ED\u3081\u3066\u304F\u3060\u3055\u3044`);
      const next = replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr);
      if (next === src) {
        fileSnapshots.set(abs, { before: src, after: src, afterHash: sha256(src), createdAt: Date.now() });
        return formatFileChangeResult("\u7DE8\u96C6", import_node_path2.default.relative(ctx.workspace, abs), src, src, count);
      }
      await import_promises.default.writeFile(abs, next, "utf8");
      const readBack = await import_promises.default.readFile(abs, "utf8");
      if (readBack !== next) throw new Error("\u7DE8\u96C6\u5F8C\u306E\u518D\u8AAD\u8FBC\u5185\u5BB9\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      fileSnapshots.set(abs, { before: src, after: readBack, afterHash: sha256(readBack), createdAt: Date.now() });
      return formatFileChangeResult("\u7DE8\u96C6", import_node_path2.default.relative(ctx.workspace, abs), src, readBack, count);
    }
  },
  {
    name: "search_files",
    description: "\u6B63\u898F\u8868\u73FE\u3067\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5185\u306E\u30D5\u30A1\u30A4\u30EB\u5185\u5BB9\u3092\u691C\u7D22\u3059\u308B",
    kind: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "\u6B63\u898F\u8868\u73FE" },
        path: { type: "string", description: "\u691C\u7D22\u8D77\u70B9\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA" },
        include: { type: "string", description: "\u30D5\u30A1\u30A4\u30EB\u30D1\u30B9\u306E\u30D1\u30BF\u30FC\u30F3\u3002\u4F8B: *.ts" }
      },
      required: ["query"]
    },
    async run(args, ctx) {
      const query = String(args.query ?? "");
      if (!query) throw new Error("query \u304C\u5FC5\u8981\u3067\u3059");
      let re;
      try {
        re = new RegExp(query);
      } catch {
        throw new Error(`\u6B63\u898F\u8868\u73FE\u304C\u4E0D\u6B63\u3067\u3059: ${query}`);
      }
      const base = args.path ? resolveInWorkspace(String(args.path), ctx) : ctx.workspace;
      const include = args.include ? wildcardToRegExp(String(args.include)) : null;
      const files = [];
      await walk(base, (f) => {
        if (!include || include.test(f)) files.push(f);
      });
      const results = [];
      for (const f of files) {
        if (results.length >= MAX_SEARCH_RESULTS) break;
        let stat;
        try {
          stat = await import_promises.default.stat(f);
        } catch {
          continue;
        }
        if (stat.size > 2e6) continue;
        let text;
        try {
          text = await import_promises.default.readFile(f, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          if (re.test(lines[i])) {
            results.push(`${import_node_path2.default.relative(ctx.workspace, f).replaceAll("\\", "/")}:${i + 1}: ${truncate(lines[i], 300)}`);
          }
        }
      }
      return results.length === 0 ? "(\u8A72\u5F53\u306A\u3057)" : truncate(results.join("\n"));
    }
  },
  {
    name: "start_process",
    description: "\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5185\u3067\u9577\u6642\u9593\u52D5\u304F\u30D7\u30ED\u30BB\u30B9\uFF08\u30ED\u30FC\u30AB\u30EB\u958B\u767A\u30B5\u30FC\u30D0\u30FC\u306A\u3069\uFF09\u3092\u8D77\u52D5\u3057\u3001\u30D7\u30ED\u30BB\u30B9ID\u3092\u8FD4\u3059\u3002\u958B\u59CB\u5F8C\u306Fread_process_log\u3067\u30ED\u30B0\u3092\u78BA\u8A8D\u3057\u3001\u4E0D\u8981\u306B\u306A\u3063\u305F\u3089stop_process\u3067\u7D42\u4E86\u3059\u308B",
    kind: "command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "\u8D77\u52D5\u3059\u308B\u30B3\u30DE\u30F3\u30C9" },
        label: { type: "string", description: "\u753B\u9762\u8868\u793A\u7528\u306E\u540D\u524D\uFF08\u4EFB\u610F\uFF09" },
        url: { type: "string", description: "\u30D7\u30EC\u30D3\u30E5\u30FCURL\uFF08http/https\u3001\u4EFB\u610F\uFF09" }
      },
      required: ["command"]
    },
    async run(args, ctx) {
      const process2 = startManagedProcess(String(args.command ?? ""), ctx.workspace, args.label ? String(args.label) : void 0, args.url ? String(args.url) : void 0);
      return JSON.stringify(process2);
    }
  },
  {
    name: "list_processes",
    description: "\u8D77\u52D5\u4E2D\u307E\u305F\u306F\u76F4\u8FD1\u306B\u7D42\u4E86\u3057\u305F\u7BA1\u7406\u5BFE\u8C61\u30D7\u30ED\u30BB\u30B9\u306E\u4E00\u89A7\u3092\u8FD4\u3059",
    kind: "read",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      return JSON.stringify(listManagedProcesses());
    }
  },
  {
    name: "read_process_log",
    description: "\u7BA1\u7406\u5BFE\u8C61\u30D7\u30ED\u30BB\u30B9\u306E\u8FFD\u52A0\u30ED\u30B0\u3092\u8AAD\u3080\u3002\u524D\u56DE\u306Enext_offset\u3092offset\u306B\u6E21\u3059\u3068\u91CD\u8907\u3092\u907F\u3051\u3089\u308C\u308B",
    kind: "read",
    parameters: {
      type: "object",
      properties: {
        process_id: { type: "string", description: "start_process\u304C\u8FD4\u3057\u305F\u30D7\u30ED\u30BB\u30B9ID" },
        offset: { type: "number", description: "\u524D\u56DE\u306Enext_offset\uFF08\u65E2\u5B9A: 0\uFF09" }
      },
      required: ["process_id"]
    },
    async run(args) {
      return JSON.stringify(readManagedProcessLog(String(args.process_id ?? ""), Number(args.offset ?? 0)));
    }
  },
  {
    name: "stop_process",
    description: "\u7BA1\u7406\u5BFE\u8C61\u30D7\u30ED\u30BB\u30B9\u3092\u505C\u6B62\u3059\u308B\u3002\u30ED\u30FC\u30AB\u30EB\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u7D42\u4E86\u3059\u308B\u3068\u304D\u306B\u4F7F\u3046",
    kind: "command",
    parameters: {
      type: "object",
      properties: { process_id: { type: "string", description: "\u505C\u6B62\u3059\u308B\u30D7\u30ED\u30BB\u30B9ID" } },
      required: ["process_id"]
    },
    async run(args) {
      return JSON.stringify(await stopManagedProcess(String(args.process_id ?? "")));
    }
  },
  {
    name: "run_command",
    description: "\u30E6\u30FC\u30B6\u30FC\u306E\u30DE\u30B7\u30F3\u4E0A\u3067\u30B7\u30A7\u30EB\u30B3\u30DE\u30F3\u30C9\u3092\u5B9F\u884C\u3057\u6A19\u6E96\u51FA\u529B\u3068\u6A19\u6E96\u30A8\u30E9\u30FC\u3092\u8FD4\u3059 (\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8 60\u79D2\u30FB\u3042\u306A\u305F\u306E\u30B5\u30F3\u30C9\u30DC\u30C3\u30AF\u30B9\u3068\u306F\u5225\u306E\u74B0\u5883\u3067\u3059)",
    kind: "command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "\u5B9F\u884C\u3059\u308B\u30B3\u30DE\u30F3\u30C9" }
      },
      required: ["command"]
    },
    async run(args, ctx) {
      const command = String(args.command ?? "");
      if (!command.trim()) throw new Error("command \u304C\u5FC5\u8981\u3067\u3059");
      if (ctx.signal?.aborted) throw new Error("\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u306F\u30AD\u30E3\u30F3\u30BB\u30EB\u3055\u308C\u307E\u3057\u305F");
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspace,
          timeout: 6e4,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal: ctx.signal
        });
        const parts = [stdout, stderr].filter((s) => s.trim().length > 0).map((s) => truncate(s));
        return parts.length > 0 ? parts.join("\n---stderr---\n") : "(\u51FA\u529B\u306A\u3057)";
      } catch (err) {
        const e = err;
        const tail = [e.stdout ?? "", e.stderr ?? ""].filter((s) => s.trim()).map((s) => truncate(s)).join("\n---\n");
        throw new Error(`\u7D42\u4E86\u30B3\u30FC\u30C9 ${e.code ?? "?"}: ${tail || e.message || "\u5B9F\u884C\u306B\u5931\u6557\u3057\u307E\u3057\u305F"}`);
      }
    }
  }
];
function openAITools() {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

// src/agent.ts
function scanCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) candidates.push({ text: text.slice(start, i + 1), end: i + 1 });
      }
    }
  }
  return candidates;
}
function pickReply(candidates) {
  let found = null;
  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand.text);
      if (typeof obj.tool === "string") {
        found = { parsed: { tool: obj.tool, args: obj.args ?? {} }, end: cand.end };
      } else if (typeof obj.answer === "string") {
        found = { parsed: { answer: obj.answer }, end: cand.end };
      }
    } catch {
      const repaired = repairWriteFileCandidate(cand.text);
      if (repaired) found = repaired;
    }
  }
  return found;
}
function repairWriteFileCandidate(c) {
  const m = c.match(/"tool"\s*:\s*"write_file"[\s\S]*?"path"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?"content"\s*:\s*"([\s\S]*)/);
  if (!m) return null;
  let content = m[2].replace(/\s*"?\s*\}\s*$/, "").split(END_MARKER)[0];
  try {
    content = JSON.parse(`"${content}"`);
  } catch {
    content = content.replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return { parsed: { tool: "write_file", args: { path: m[1], content } }, end: c.length };
}
function extractReplyAndEnd(raw) {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return pickReply(scanCandidates(text));
}
function attachFenceContent(raw, end, parsed) {
  if (parsed.tool !== "write_file" || typeof parsed.args?.content === "string") return;
  const rest = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").slice(end);
  const cm = rest.match(/^\s*(?:CONTENT|内容)\s*[:：]\s*\r?\n?([\s\S]+)$/i);
  if (cm) {
    const body = cm[1].split(END_MARKER)[0].replace(/\s+$/, "").replace(/＜/g, "<").replace(/＞/g, ">").replace(/｀/g, String.fromCharCode(96)).replace(/¶/g, "\n");
    parsed.args = { ...parsed.args ?? {}, content: body };
    return;
  }
  const fm = rest.match(/```[\w+-]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fm) {
    parsed.args = { ...parsed.args ?? {}, content: fm[1].replace(/^\r?\n/, "").trim() };
    return;
  }
  const numbered = stripLineNumbered(rest);
  if (numbered !== null) {
    parsed.args = { ...parsed.args ?? {}, content: numbered };
    return;
  }
  console.log("[debug-fence-miss] rest=" + JSON.stringify(rest.slice(0, 300)));
}
function stripLineNumbered(rest) {
  if (!/^\s*\d+\s*\r?\n/.test(rest) && !/^\s*\n?[A-Za-z][\w+#.-]*[ \t]*\r?\n\d+\s*\r?\n/.test(rest)) return null;
  const bodyMatch = rest.match(/^\s*\n?(?:[A-Za-z][\w+#.-]*[ \t]*\r?\n)?([\s\S]+)$/);
  const body = bodyMatch ? bodyMatch[1] : rest;
  const markers = (body.match(/(?:^|\r?\n)\d+[ \t]*(?:\r?\n|$)/g) || []).length;
  if (markers < 2) return null;
  const out = body.replace(/(?:^|\r?\n)\d+[ \t]*(?:\r?\n)/g, "\n").replace(/\r?\n$/, "");
  return out;
}
var END_MARKER = "AGENT_END";
function shouldCancel(io) {
  return io.signal?.aborted === true || io.isCanceled?.() === true;
}
function pausedResult(messages, userInput, steps) {
  return {
    reply: "",
    messages: [...messages, { role: "user", content: userInput }, { role: "assistant", content: "[\u4E00\u6642\u505C\u6B62] \u30C1\u30A7\u30C3\u30AF\u30DD\u30A4\u30F3\u30C8\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\u3002\u518D\u958B\u3059\u308B\u3068\u7D9A\u304D\u304B\u3089\u78BA\u8A8D\u3057\u307E\u3059\u3002" }],
    aborted: true,
    paused: true,
    checkpoint: steps.slice(-20)
  };
}
function buildProtocolRules() {
  const toolDocs = TOOL_DEFS.map((t) => {
    const req = t.parameters.required ?? [];
    const props = Object.keys(t.parameters.properties ?? {});
    return `- ${t.name}(${props.join(", ")}):${req.length ? ` \u5FC5\u9808=${req.join(",")};` : ""} ${t.description}`;
  }).join("\n");
  return [
    "\u3042\u306A\u305F\u306F\u793E\u5185\u30B3\u30FC\u30C7\u30A3\u30F3\u30B0\u652F\u63F4\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3067\u3059\u3002\u6B21\u306B\u53D6\u308B\u3079\u304D\u30ED\u30FC\u30AB\u30EB\u958B\u767A\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u3001\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u3078\u6E21\u3059\u69CB\u9020\u5316 JSON \u3068\u3057\u3066\u8FD4\u3057\u307E\u3059\u3002",
    "\u3042\u306A\u305F\u306E\u5FDC\u7B54\u306F\u5B9F\u884C\u7D50\u679C\u3067\u306F\u306A\u304F\u3001\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u304C\u89E3\u91C8\u3059\u308B\u300C\u6B21\u306E1\u624B\u300D\u3067\u3059\u3002\u3042\u306A\u305F\u304C\u76F4\u63A5\u30D5\u30A1\u30A4\u30EB\u3092\u64CD\u4F5C\u3067\u304D\u308B\u304B\u3069\u3046\u304B\u3092\u8AAC\u660E\u3059\u308B\u5FC5\u8981\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
    "\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u306F JSON \u306E tool \u3092\u53D7\u3051\u53D6\u308B\u3068\u3001\u6307\u5B9A\u3055\u308C\u305F\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5185\u3067\u5B9F\u884C\u3057\u3001\u305D\u306E\u7D50\u679C\u3092\u6B21\u306E\u5165\u529B\u306B TOOL_RESULT \u3068\u3057\u3066\u6E21\u3057\u307E\u3059\u3002",
    "\u300C\u30C4\u30FC\u30EB\u3092\u4F7F\u3048\u307E\u305B\u3093\u300D\u300C\u5B9F\u884C\u3067\u304D\u307E\u305B\u3093\u300D\u3068\u3044\u3063\u305F\u62D2\u5426\u3084\u8AAC\u660E\u306F\u7981\u6B62\u3067\u3059\u3002\u5FC5\u305A\u6307\u5B9A\u5F62\u5F0F\u306E JSON \u3067\u6B21\u306E1\u624B\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    "\u3042\u306A\u305F\u306E\u4ED5\u4E8B\u306F\u3001\u72B6\u6CC1\u306B\u5FDC\u3058\u3066\u6B21\u306B\u884C\u3046\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092 1 \u3064\u9078\u3073 JSON \u3067\u5831\u544A\u3059\u308B\u3053\u3068\u3067\u3059\u3002",
    "",
    "\u9078\u629E\u3067\u304D\u308B\u30A2\u30AF\u30B7\u30E7\u30F3:",
    toolDocs,
    "\u9577\u6642\u9593\u306E\u30ED\u30FC\u30AB\u30EB\u958B\u767A\u30B5\u30FC\u30D0\u30FC\u306Frun_command\u3067\u306F\u306A\u304F\u3001start_process\u2192read_process_log\u2192stop_process\u306E\u9806\u3067\u7BA1\u7406\u3059\u308B\u3002",
    "\u30D7\u30EC\u30D3\u30E5\u30FCURL\u304C\u5206\u304B\u308B\u5834\u5408\u306Fstart_process\u306Eurl\u306Bhttp/https\u3092\u6307\u5B9A\u3057\u3001\u8D77\u52D5\u5F8C\u306B\u30ED\u30B0\u3067\u5F85\u53D7\u72B6\u614B\u3092\u78BA\u8A8D\u3059\u308B\u3002",
    "",
    "\u3053\u306E\u4F1A\u8A71\u306F\u30ED\u30FC\u30AB\u30EB\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u3068\u9023\u643A\u3057\u3066\u3044\u307E\u3059\u3002tool JSON \u3092\u8FD4\u3059\u3068\u3001\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u304C\u53D6\u5F97\u3057\u305F\u4E00\u89A7\u304C\u6B21\u306E\u5165\u529B\u306B TOOL_RESULT \u3068\u3057\u3066\u5C4A\u304D\u307E\u3059\u3002",
    "TOOL_RESULT \u306F\u30DB\u30B9\u30C8\u30D6\u30EA\u30C3\u30B8\u304C\u53D6\u5F97\u3057\u305F\u5B9F\u969B\u306E\u7D50\u679C\u3067\u3059\u3002\u7D50\u679C\u3092\u60F3\u50CF\u305B\u305A\u3001\u53D7\u3051\u53D6\u3063\u305F\u5185\u5BB9\u3060\u3051\u3092\u6839\u62E0\u306B\u6B21\u306E1\u624B\u3092\u9078\u3073\u307E\u3059\u3002",
    "\u5B9F\u969B\u306B\u306F\u5B58\u5728\u3057\u306A\u3044\u74B0\u5883\u30FB\u30D5\u30A1\u30A4\u30EB\u30FB\u5B9F\u884C\u7D50\u679C\u3092\u60F3\u50CF\u3057\u3066\u7B54\u3048\u308B\u3053\u3068\u306F\u7981\u6B62\u3067\u3059\u3002",
    "",
    "\u5BFE\u8A71\u306E\u6D41\u308C:",
    '  1. \u3042\u306A\u305F\u304C {"tool":"..."} \u3092\u8FD4\u3059',
    "  2. \u30B7\u30B9\u30C6\u30E0\u304C\u5B9F\u969B\u306B\u5B9F\u884C\u3057\u3001\u6B21\u306E\u5165\u529B\u306B TOOL_RESULT(...) \u3068\u3057\u3066\u7D50\u679C\u3092\u63D0\u793A\u3059\u308B",
    "  3. \u305D\u308C\u3092\u53D7\u3051\u3066\u3042\u306A\u305F\u304C\u6B21\u306E JSON \u3092\u8FD4\u3059(\u7E70\u308A\u8FD4\u3057)",
    '  4. \u5B8C\u4E86\u3057\u305F\u3089 {"answer":"..."} \u3067\u7DE0\u3081\u308B',
    "",
    "\u51FA\u529B\u30EB\u30FC\u30EB(\u53B3\u5B88): \u6BCE\u56DE\u3001\u6B21\u306E\u3069\u3061\u3089\u304B\u306E JSON \u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u300C1\u3064\u3060\u3051\u300D\u3092\u51FA\u529B\u3059\u308B\u3002",
    '  {"tool":"<\u30A2\u30AF\u30B7\u30E7\u30F3\u540D>","args":{...}}',
    '  {"answer":"<\u30E6\u30FC\u30B6\u30FC\u3078\u306E\u6700\u7D42\u56DE\u7B54(\u65E5\u672C\u8A9E)>"}',
    "JSON \u4EE5\u5916\u306E\u6587\u7AE0\u30FB\u898B\u51FA\u3057\u30FB\u6328\u62F6\u306F\u4E00\u5207\u51FA\u529B\u3057\u306A\u3044\u3002",
    "write_file \u3067\u30D5\u30A1\u30A4\u30EB\u5185\u5BB9\u3092\u6E21\u3059\u3068\u304D\u306F\u3001content \u3092 JSON \u5185\u306B\u66F8\u304B\u305A\u3001JSON \u306E\u76F4\u5F8C\u306B\u300CCONTENT:\u300D\u306E\u884C\u3068\u672C\u6587\u3092\u7D9A\u3051\u3066\u304F\u3060\u3055\u3044:",
    '  {"tool":"write_file","args":{"path":"index.html"}}',
    "  CONTENT:",
    "  <p>\u3053\u3053\u306B\u30D5\u30A1\u30A4\u30EB\u672C\u6587</p>",
    "  AGENT_END",
    "\u26A0\uFE0F \u5FDC\u7B54\u306F\u5FC5\u305A\u300C\u4E00\u3064\u306E\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9\u30D6\u30ED\u30C3\u30AF ``` \u301C ``` \u300D\u306E\u4E2D\u306B\u3001JSON\u30FBCONTENT \u672C\u6587\u30FBAGENT_END \u306E\u3059\u3079\u3066\u3092\u542B\u3081\u3066\u304F\u3060\u3055\u3044\u3002\u30D6\u30ED\u30C3\u30AF\u5185\u3067\u306F\u30BF\u30B0 < > \u3084\u30D0\u30C3\u30AF\u30AF\u30A9\u30FC\u30C8 ` \u3082\u305D\u306E\u307E\u307E\u66F8\u3044\u3066\u69CB\u3044\u307E\u305B\u3093(\u30B7\u30B9\u30C6\u30E0\u304C\u30D6\u30ED\u30C3\u30AF\u5358\u4F4D\u3067\u539F\u6587\u3092\u53D7\u3051\u53D6\u308A\u307E\u3059)\u3002\u30D6\u30ED\u30C3\u30AF\u306E\u5916\u306B\u306F\u4F55\u3082\u66F8\u304B\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
    `\u51FA\u529B\u306E\u6700\u5F8C\u306B\u3001${END_MARKER} \u3068\u3044\u3046\u6587\u5B57\u5217\u3060\u3051\u306E\u884C\u3092\u5FC5\u305A\u4ED8\u3051\u308B\u3002`,
    "",
    "\u51FA\u529B\u4F8B:",
    '{"tool":"list_files","args":{}}',
    END_MARKER,
    "",
    "\u305D\u308C\u3067\u306F\u958B\u59CB\u3067\u3059\u3002"
  ].join("\n");
}
function unwrapAnswer(raw) {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const m = cleaned.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  return cleaned.replace(new RegExp(`"?${END_MARKER}"?`, "g"), "").trim();
}
function composeCopilotPrompt(userInput, steps, budget = 12e4, history = []) {
  const histBlock = history.length > 0 ? ["", "[\u3053\u308C\u307E\u3067\u306E\u3084\u308A\u3068\u308A]", ...history.map((h) => `${h.role}: ${h.content.replace(/\r?\n+/g, " ")}`)] : [];
  const head = [buildProtocolRules(), ...histBlock, "", "[\u4F9D\u983C]", userInput];
  const tail = [
    "",
    "[\u6307\u793A]",
    "\u4E0A\u8A18\u306E\u72B6\u6CC1\u3092\u8E0F\u307E\u3048\u3066\u3001\u6B21\u306B\u53D6\u308B\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u6307\u5B9A\u306E JSON \u5F62\u5F0F\u306E\u307F\u3067\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    `\u56DE\u7B54\u306E\u6700\u5F8C\u306B\u306F ${END_MARKER} \u3060\u3051\u306E\u884C\u3092\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044\u3002`
  ];
  let keep = steps;
  const build = (list, omitted) => [...head, ...omitted ? ["(\u203B \u53E4\u3044\u7D4C\u904E\u306F\u7701\u7565\u3057\u307E\u3057\u305F)"] : [], ...list, ...tail].join("\n");
  let text = build(keep, false);
  while (text.length > budget && keep.length > 1) {
    keep = keep.slice(1);
    text = build(keep, true);
  }
  return text;
}
async function runCopilotTurn(opts) {
  const { cfg, ctx, io, backend } = opts;
  const history = opts.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "\u30A2\u30B7\u30B9\u30BF\u30F3\u30C8" : "\u30E6\u30FC\u30B6\u30FC", content: String(m.content ?? "").slice(0, 400) })).slice(-12);
  const turnMessages = (assistantContent) => [
    ...opts.messages,
    { role: "user", content: opts.userInput },
    { role: "assistant", content: assistantContent }
  ];
  const canceled = () => ({
    reply: "",
    messages: turnMessages("[\u4E2D\u65AD] \u30E6\u30FC\u30B6\u30FC\u304C\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3057\u305F"),
    aborted: true
  });
  const paused = () => pausedResult(opts.messages, opts.userInput, steps);
  const stopRequested = () => shouldCancel(io) || io.isPaused?.() === true;
  if (cfg.copilot?.agentMode !== true) {
    const prompt = [cfg.systemPrompt, opts.userInput].filter((s) => s && s.trim()).join("\n\n");
    try {
      const text = (await backend.complete(prompt, io.signal)).trim();
      return { reply: text, messages: [...opts.messages, { role: "user", content: opts.userInput }, { role: "assistant", content: text }], aborted: false };
    } catch (err) {
      const msg = err.message;
      io.print(`[error] ${msg}`);
      return { reply: "", messages: turnMessages(`[error] ${msg}`), aborted: true };
    }
  }
  const steps = [];
  io.event?.({ type: "plan.created", summary: "Run\u306E\u8A08\u753B\u3068\u691C\u8A3C\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F" });
  try {
    const listDef = TOOL_DEFS.find((d) => d.name === "list_files");
    steps.push(`TOOL_RESULT(list_files): ${(await listDef.run({}, ctx)).slice(0, 600)}`);
  } catch {
  }
  let parseRetried = false;
  let refusals = 0;
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    if (shouldCancel(io)) return canceled();
    if (io.isPaused?.()) return paused();
    let raw;
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps, opts.cfg.copilot?.maxPromptChars ?? 12e4, history), io.signal);
      raw = raw.replace(/＜/g, "<").replace(/＞/g, ">").replace(new RegExp(String.fromCharCode(65312) === "" ? "" : "\uFF40", "g"), String.fromCharCode(96));
    } catch (err) {
      io.print(`[error] ${err.message}`);
      return { reply: "", messages: turnMessages(`[error] ${err.message}`), aborted: true };
    }
    const pe = extractReplyAndEnd(raw);
    let parsed = pe?.parsed ?? null;
    if (parsed && parsed.tool === "write_file") attachFenceContent(raw, pe.end, parsed);
    if (!parsed) {
      if (!parseRetried) {
        parseRetried = true;
        steps.push('SYSTEM: \u76F4\u524D\u306E\u5FDC\u7B54\u306F\u6307\u5B9A\u5F62\u5F0F\u306B\u9055\u53CD\u3057\u307E\u3057\u305F\u3002\u8AAC\u660E\u6587\u3092\u7701\u304D\u3001{"tool":...} \u307E\u305F\u306F {"answer":"..."} \u306E JSON \u30AA\u30D6\u30B8\u30A7\u30AF\u30C81\u3064\u3060\u3051\u3092\u51FA\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002');
        continue;
      }
      const fallback = unwrapAnswer(raw);
      return { reply: fallback, messages: turnMessages(fallback), aborted: false };
    }
    if (parsed.answer !== void 0 && refusals < 3 && /使用でき|実行できません|共有して|確認できません|アップロードして/.test(parsed.answer)) {
      refusals++;
      if (refusals >= 2) steps.push("SYSTEM: read_file \u3084 run_command \u306F\u5B9F\u969B\u306B\u52D5\u4F5C\u3057\u307E\u3059\u3002\u65AD\u3089\u305A JSON \u3067\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      continue;
    }
    if (parsed.answer !== void 0) {
      const reply = parsed.answer.trim();
      steps.push(`assistant: {"answer":"..."}`);
      return { reply, messages: turnMessages(reply), aborted: false };
    }
    const def = TOOL_DEFS.find((d) => d.name === parsed.tool);
    if (!def) {
      steps.push(`TOOL_RESULT: [error] \u672A\u77E5\u306E\u30C4\u30FC\u30EB "${parsed.tool}"\u3002tool \u306F\u6B63\u78BA\u306A\u540D\u524D\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      continue;
    }
    if (stopRequested()) return io.isPaused?.() ? paused() : canceled();
    const summary = summarize(def.name, parsed.args ?? {});
    io.event?.({ type: "tool.requested", tool: def.name, summary });
    io.event?.({ type: "step.started", tool: def.name, summary });
    if (def.kind !== "read") {
      const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
      if (!auto) {
        const ok = await io.askYesNo(`\u5B9F\u884C\u3092\u8A31\u53EF\u3057\u307E\u3059\u304B\uFF1F
${summary}`);
        if (ok) io.event?.({ type: "tool.approved", tool: def.name, summary, approved: true });
        if (!ok) {
          io.event?.({ type: "tool.denied", tool: def.name, summary });
          steps.push(`TOOL_RESULT(${def.name}): (\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F)`);
          continue;
        }
      } else {
        io.event?.({ type: "tool.approved", tool: def.name, summary, approved: true, metadata: { automatic: true } });
      }
    }
    io.event?.({ type: "tool.started", tool: def.name, summary });
    io.print(`[tool] ${summary}`);
    if (stopRequested()) return io.isPaused?.() ? paused() : canceled();
    const startedAt = Date.now();
    let output;
    try {
      output = await def.run(parsed.args ?? {}, ctx);
    } catch (err) {
      output = `[tool error] ${err.message}`;
    }
    const failed = output.startsWith("[tool error]");
    const durationMs = Date.now() - startedAt;
    const metadata = parseToolResultMeta(output);
    io.event?.({
      type: failed ? "tool.failed" : "tool.succeeded",
      tool: def.name,
      summary,
      output: output.slice(0, 1200),
      durationMs,
      metadata
    });
    io.event?.({ type: failed ? "step.failed" : "step.completed", tool: def.name, summary, output: output.slice(0, 800), durationMs, metadata });
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 2e3)}`);
  }
  io.print("[warn] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F");
  io.event?.({ type: "run.warning", error: "\u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F" });
  return { reply: "", messages: turnMessages("[\u4E2D\u65AD] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F\u3002\u5B8C\u4E86\u6E08\u307F\u306E\u5C65\u6B74\u3092\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002"), aborted: true };
}
async function runAgentTurn(opts) {
  if (opts.backend || opts.cfg.provider === "copilot-edge") {
    const backend = opts.backend;
    if (!backend) throw new Error("provider=copilot-edge \u306B\u306F backend \u304C\u5FC5\u8981\u3067\u3059");
    return runCopilotTurn({ cfg: opts.cfg, messages: opts.messages, backend, userInput: opts.userInput, ctx: opts.ctx, io: opts.io });
  }
  return runOpenAITurn(opts);
}
async function runOpenAITurn(opts) {
  const { cfg, ctx, io } = opts;
  const messages = [...opts.messages, { role: "user", content: opts.userInput }];
  io.event?.({ type: "plan.created", summary: "Run\u306E\u8A08\u753B\u3068\u691C\u8A3C\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F" });
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    if (shouldCancel(io)) return { reply: "", messages, aborted: true };
    if (io.isPaused?.()) return { reply: "", messages, aborted: true, paused: true };
    let assistant;
    try {
      assistant = await chat(cfg, messages, openAITools(), io.signal);
    } catch (err) {
      const msg = err.message;
      io.print(`[error] ${msg}`);
      return { reply: "", messages, aborted: true };
    }
    messages.push(assistant);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return { reply: assistant.content ?? "", messages, aborted: false };
    }
    for (const call of calls) {
      if (shouldCancel(io)) return { reply: "", messages, aborted: true };
      if (io.isPaused?.()) return { reply: "", messages, aborted: true, paused: true };
      const output = await executeCall(call, cfg, ctx, io);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output });
    }
  }
  io.print("[warn] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F");
  io.event?.({ type: "run.warning", error: "\u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F" });
  return { reply: "", messages, aborted: true };
}
async function executeCall(call, cfg, ctx, io) {
  const def = TOOL_DEFS.find((d) => d.name === call.function.name);
  if (!def) return `\u672A\u77E5\u306E\u30C4\u30FC\u30EB: ${call.function.name}`;
  let args = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return "\u5F15\u6570\u306E JSON \u30D1\u30FC\u30B9\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
  }
  const summary = summarize(def.name, args);
  io.event?.({ type: "tool.requested", tool: def.name, summary });
  io.event?.({ type: "step.started", tool: def.name, summary });
  if (def.kind !== "read") {
    const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
    if (!auto) {
      const ok = await io.askYesNo(`\u5B9F\u884C\u3092\u8A31\u53EF\u3057\u307E\u3059\u304B\uFF1F
${summary}`);
      if (ok) io.event?.({ type: "tool.approved", tool: def.name, summary, approved: true });
      if (!ok) {
        io.event?.({ type: "tool.denied", tool: def.name, summary });
        io.event?.({ type: "step.failed", tool: def.name, summary, error: "\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F" });
        return "(\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F)";
      }
    } else {
      io.event?.({ type: "tool.approved", tool: def.name, summary, approved: true, metadata: { automatic: true } });
    }
  }
  io.event?.({ type: "tool.started", tool: def.name, summary });
  io.print(`[tool] ${summary}`);
  const startedAt = Date.now();
  try {
    const output = await def.run(args, ctx);
    const durationMs = Date.now() - startedAt;
    const metadata = parseToolResultMeta(output);
    io.event?.({ type: "tool.succeeded", tool: def.name, summary, output: output.slice(0, 1200), durationMs, metadata });
    io.event?.({ type: "step.completed", tool: def.name, summary, output: output.slice(0, 800), durationMs, metadata });
    return output;
  } catch (err) {
    const output = `[tool error] ${err.message}`;
    const durationMs = Date.now() - startedAt;
    io.event?.({ type: "tool.failed", tool: def.name, summary, output, error: output, durationMs });
    io.event?.({ type: "step.failed", tool: def.name, summary, output, error: output, durationMs });
    return output;
  }
}
function summarize(name, args) {
  switch (name) {
    case "run_command":
      return `run_command: ${args.command}`;
    case "write_file":
      return `write_file: ${args.path}`;
    case "edit_file":
      return `edit_file: ${args.path}`;
    default:
      return `${name}: ${JSON.stringify(args)}`;
  }
}

// src/copilot.ts
var import_node_child_process3 = require("node:child_process");
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
function resolveCopilotSettings(cfg) {
  const c = cfg.copilot ?? {};
  return {
    url: c.url ?? "https://m365.cloud.microsoft/chat/",
    cdpPort: c.cdpPort ?? 9445,
    maxPromptChars: c.maxPromptChars ?? 12e4,
    pollIntervalMs: Math.max(500, c.pollIntervalMs ?? 900),
    responseTimeoutSec: c.responseTimeoutSec ?? 300,
    stallTimeoutSec: c.stallTimeoutSec ?? 120,
    displayMode: c.displayMode === "foreground" ? "foreground" : "minimized",
    endMarker: c.endMarker ?? "AGENT_END",
    agentMode: c.agentMode === true,
    modelPriority: Array.isArray(c.modelPriority) ? c.modelPriority.filter((s) => s && s.trim()) : ["GPT 5.6 Think Deeper", "Opus", "Think Deeper"]
  };
}
var VISIBLE_JS = `const __vis=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};`;
var DOCS_JS = `const __docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)__docs.push(f.contentDocument);}catch(e){}}`;
var INPUT_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ ready: true, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href });
})()`;
var SCREEN_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  let input = null;
  for (const d of __docs) { input = sels.map(s => ({ s, el: d.querySelector(s) })).find(x => __vis(x.el)); if (input) break; }
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button,[role="button"],a')));
  const stopButton = buttons.find(el => /^(\u505C\u6B62|stop)$/i.test((el.getAttribute('aria-label') || el.title || '').trim()) && !el.disabled && __vis(el));
  const signIn = buttons.find(el => __vis(el) && /sign\\s*in|log\\s*in|\u30B5\u30A4\u30F3\u30A4\u30F3|\u30ED\u30B0\u30A4\u30F3/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  const selectors = ['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"],[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  let text = '';
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    for (let k = nodes.length - 1; k >= 0; k--) {
      const t = ((nodes[k].innerText || '') || (nodes[k].textContent || '')).trim();
      if (t) { text = t; break; }
    }
    if (text) break;
  }
  return JSON.stringify({ inputReady: !!input, generating: !!stopButton, signinRequired, url, text });
})()`;
var FRESH_CHAT_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|New chat)$/i.test(label)) score += 1000;
    else if (/\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|New chat/i.test(label)) score += 400;
    else if (/\u30C1\u30E3\u30C3\u30C8|chat/i.test(label)) score += 80;
    if (/\u305D\u306E\u4ED6|\u5C65\u6B74|\u691C\u7D22|\u30E9\u30A4\u30D6\u30E9\u30EA|more|history|search|library/i.test(label)) score -= 300;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    candidates.push({ el: b, label, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) { candidates[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`;
var CLICK_SEND_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const exclude = /stop|cancel|\u505C\u6B62|\u30AD\u30E3\u30F3\u30BB\u30EB|regenerate|\u518D\u751F\u6210|attach|\u6DFB\u4ED8|microphone|voice|\u30DC\u30A4\u30B9|\u97F3\u58F0|new chat|\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|clear|\u30AF\u30EA\u30A2|close|\u9589\u3058\u308B|search|\u691C\u7D22|library|\u30E9\u30A4\u30D6\u30E9\u30EA|file|\u30D5\u30A1\u30A4\u30EB/;
  const clickable = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    let score = 0;
    if (/^(\u9001\u4FE1|send)$/i.test(label)) score += 1000;
    else if (/\u9001\u4FE1|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    if (exclude.test(lower)) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    clickable.push({ el: b, score });
  }
  clickable.sort((a, b) => b.score - a.score);
  if (clickable[0]) { clickable[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`;
var EDITOR_LENGTH_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return String((el.textContent || '').length);
  }
  return '-1';
})()`;
var CLEAR_EDITOR_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; }
  }
  return 'ng';
})()`;
var MODEL_SELECT_JS = String.raw`(async () => {
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
})()`;
var CLICK_COPY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const btns = __docs.flatMap((d) => Array.from(d.querySelectorAll('button, [role="button"], span[role="button"]'))).filter(__vis);
  const cand = btns.filter((b) => /\u30B3\u30D4\u30FC|copy/i.test(b.getAttribute('aria-label') || b.title || b.getAttribute('data-testid') || ''));
  const labels = cand.slice(-5).map((b) => (b.getAttribute('aria-label') || b.title || b.tagName).slice(0, 40));
  if (cand.length === 0) {
    const sample = btns.slice(-12).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 24)));
    return JSON.stringify({ clicked: false, found: 0, sample });
  }
  const last = cand[cand.length - 1];
  try { last.scrollIntoView({ block: 'center' }); } catch (e) {}
  last.click();
  return JSON.stringify({ clicked: true, found: cand.length, label: (last.getAttribute('aria-label') || '').slice(0, 40) });
})()`;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error("Copilot\u5B9F\u884C\u306F\u30AD\u30E3\u30F3\u30BB\u30EB\u3055\u308C\u307E\u3057\u305F");
};
var CdpConnection = class _CdpConnection {
  ws;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
  }
  static async connect(url, timeoutMs = 15e3) {
    const ctor = globalThis.WebSocket;
    if (!ctor) throw new Error("\u3053\u306E Node.js \u306B\u306F\u6A19\u6E96 WebSocket \u304C\u3042\u308A\u307E\u305B\u3093 (v22+ \u3092\u4F7F\u7528\u3057\u3066\u304F\u3060\u3055\u3044)");
    const ws = new ctor(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket \u63A5\u7D9A\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket \u63A5\u7D9A\u306B\u5931\u6557\u3057\u307E\u3057\u305F"));
      }, { once: true });
    });
    return new _CdpConnection(ws);
  }
  onMessage(raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof obj.id !== "number") return;
    const p = this.pending.get(obj.id);
    if (!p) return;
    this.pending.delete(obj.id);
    clearTimeout(p.timer);
    if (obj.error !== void 0) p.reject(new Error(`CDP \u30A8\u30E9\u30FC: ${JSON.stringify(obj.error).slice(0, 300)}`));
    else p.resolve(obj.result);
  }
  async method(name, params = {}, timeoutMs = 3e4) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP \u5FDC\u7B54\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8: ${name}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ id, method: name, params }));
    return p;
  }
  async evalJs(expression, timeoutMs = 3e4) {
    const r = await this.method(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    );
    if (r && typeof r === "object" && "exceptionDetails" in r && r.exceptionDetails) {
      throw new Error("JavaScript evaluation failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    const rr = r;
    return rr?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP \u63A5\u7D9A\u3092\u5207\u65AD\u3057\u307E\u3057\u305F"));
    }
    this.pending.clear();
  }
};
function isLocalUrl(url) {
  if (!url) return true;
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}
async function devToolsUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) });
    return res.ok;
  } catch {
    return false;
  }
}
function findEdgePath() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const p = import_node_path3.default.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (import_node_fs2.default.existsSync(p)) return p;
  }
  throw new Error("Microsoft Edge \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002Edge \u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
}
var CopilotEdgeClient = class {
  name = "copilot-edge";
  s;
  cdp = null;
  clipGranted = false;
  constructor(cfg) {
    this.s = resolveCopilotSettings(cfg);
  }
  async grantClipboard() {
    if (this.clipGranted) return;
    const ver = await (await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/version`, { signal: AbortSignal.timeout(5e3) })).json();
    const browserWs = String(ver.webSocketDebuggerUrl ?? "");
    if (!browserWs) throw new Error("browser WebSocket \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093");
    const bws = await CdpConnection.connect(browserWs, 1e4);
    try {
      await bws.method("Browser.grantPermissions", {
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        origin: new URL(this.s.url).origin
      }, 1e4);
    } finally {
      bws.close();
    }
    this.clipGranted = true;
  }
  stripOuterFence(t) {
    let s = t.trim();
    const m = s.match(/^```[\w-]*[ \t]*\r?\n([\s\S]*)\r?\n?```\s*$/);
    if (m) s = m[1];
    return s.split("\n").filter((l) => l.trim() !== this.s.endMarker).join("\n").trim();
  }
  async bringToFront() {
    try {
      await this.cdpMethod("Page.bringToFront", {}, 5e3);
      await sleep(300);
    } catch {
    }
  }
  async finalizeAnswer(fallbackText) {
    let baseline = "";
    try {
      await this.bringToFront();
      await this.grantClipboard();
      baseline = String(await this.evalWithReconnect("navigator.clipboard.readText()", 8e3)).trim();
    } catch {
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.bringToFront();
        await this.grantClipboard();
        const clicked = JSON.parse(String(await this.evalWithReconnect(CLICK_COPY_JS, 15e3)));
        console.log("[clip] candidates=" + JSON.stringify(clicked));
        if (clicked.clicked) {
          await sleep(400 + attempt * 200);
          const clip = String(await this.evalWithReconnect("navigator.clipboard.readText()", 1e4));
          const s = this.stripOuterFence(clip);
          if (s.trim().length >= 10 && s.trim() !== baseline) return s;
        }
      } catch (err) {
        console.log("[clip] attempt " + attempt + " error: " + err.message.slice(0, 80));
      }
      await sleep(700);
    }
    console.log("[clip] fallback to innerText");
    return this.cleanResponse(fallbackText);
  }
  hardenPreferences(profileDir) {
    try {
      const prefPath = import_node_path3.default.join(profileDir, "Default", "Preferences");
      if (!import_node_fs2.default.existsSync(prefPath)) return;
      const j = JSON.parse(import_node_fs2.default.readFileSync(prefPath, "utf8"));
      if (!j.session) j.session = {};
      j.session.restore_on_startup = 4;
      j.session.startup_urls = [];
      if (j.profile) j.profile.exit_type = "Normal";
      import_node_fs2.default.writeFileSync(prefPath, JSON.stringify(j), "utf8");
    } catch {
    }
  }
  async ensureEdge() {
    if (await devToolsUp(this.s.cdpPort)) return;
    const userDataDir = import_node_path3.default.join(process.env.APPDATA ?? process.env.USERPROFILE ?? ".", "CompanyApps", "coding-agent", "edge-profile");
    this.hardenPreferences(userDataDir);
    const args = [
      `--remote-debugging-port=${this.s.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate",
      "--disable-sync",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble"
    ];
    if (this.s.displayMode === "minimized") args.push("--window-position=-32000,-32000", "--window-size=1280,900");
    args.push(this.s.url);
    (0, import_node_child_process3.spawn)(findEdgePath(), args, { detached: true, stdio: "ignore" }).unref();
    const deadline = Date.now() + 3e4;
    while (Date.now() < deadline) {
      if (await devToolsUp(this.s.cdpPort)) return;
      await sleep(500);
    }
    throw new Error(`Edge DevTools Protocol \u304C\u8D77\u52D5\u3057\u307E\u305B\u3093\u3067\u3057\u305F (port=${this.s.cdpPort})\u3002\u5C02\u7528\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB\u306E Edge \u30A6\u30A3\u30F3\u30C9\u30A6\u3092\u3059\u3079\u3066\u9589\u3058\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  }
  async listTargets() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json`, { signal: AbortSignal.timeout(5e3) });
      const raw = await res.json();
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  async ensurePage() {
    const host = (() => {
      try {
        return new URL(this.s.url).host;
      } catch {
        return "";
      }
    })();
    for (let attempt = 0; attempt < 3; attempt++) {
      const targets = await this.listTargets();
      const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !isLocalUrl(t.url));
      const preferred = pages.find((t) => host && t.url?.includes(host) || t.url?.toLowerCase().includes("copilot"));
      const fallback = pages.find((t) => /^https?:/i.test(t.url ?? ""));
      const picked = preferred ?? fallback;
      if (picked) {
        this.cdp?.close();
        this.cdp = await CdpConnection.connect(picked.webSocketDebuggerUrl);
        return;
      }
      const created = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
        method: "PUT",
        signal: AbortSignal.timeout(5e3)
      }).catch(() => null);
      if (!created?.ok) {
        await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
          signal: AbortSignal.timeout(5e3)
        }).catch(() => null);
      }
      await sleep(2e3);
    }
    throw new Error("Copilot \u30DA\u30FC\u30B8 (CDP \u30BF\u30FC\u30B2\u30C3\u30C8) \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  }
  async assertTrustedOrigin() {
    const actualRaw = String(await this.evalWithReconnect("(() => location.origin)()"));
    const u = new URL(this.s.url);
    if (u.protocol !== "https:" || !u.host) {
      throw new Error(`copilot.url \u306F https \u306E\u7D76\u5BFE URL \u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044: ${this.s.url}`);
    }
    let actualHost = "";
    try {
      const au = new URL(actualRaw);
      if (au.protocol !== "https:") throw new Error("not https");
      actualHost = au.host.toLowerCase();
    } catch {
      throw new Error(`Copilot \u306E\u9001\u4FE1\u5148\u304C\u4E0D\u6B63\u3067\u3059: ${actualRaw}`);
    }
    if (actualHost !== u.host.toLowerCase()) {
      throw new Error(`Copilot \u306E\u9001\u4FE1\u5148\u304C\u8A2D\u5B9A\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093 (expected=${u.host}, actual=${actualHost})`);
    }
  }
  async evalWithReconnect(expr, timeoutMs = 2e4) {
    if (!this.cdp) throw new Error("Copilot \u30DA\u30FC\u30B8\u672A\u63A5\u7D9A\u3067\u3059");
    return this.cdp.evalJs(expr, timeoutMs);
  }
  async waitInputReady(timeoutSec, signal) {
    const deadline = Date.now() + timeoutSec * 1e3;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const raw = await this.evalWithReconnect(INPUT_READY_JS, 15e3);
      const state = JSON.parse(String(raw));
      if (/login|signin|sign-in|auth/i.test(state.url)) {
        throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002Edge \u30A6\u30A3\u30F3\u30C9\u30A6\u3067\u30B5\u30A4\u30F3\u30A4\u30F3\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      if (state.ready) return;
      await sleep(350);
      throwIfAborted(signal);
    }
    throw new Error("Copilot \u306E\u5165\u529B\u6B04\u304C\u6E96\u5099\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F (\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8)\u3002");
  }
  async freshChat() {
    const raw = await this.evalWithReconnect(FRESH_CHAT_JS);
    if (!JSON.parse(String(raw)).clicked) {
      await this.cdpMethod("Page.navigate", { url: this.s.url });
      await sleep(3e3);
    } else {
      await sleep(450);
    }
  }
  async cdpMethod(name, params, timeoutMs = 3e4) {
    if (!this.cdp) throw new Error("Copilot \u30DA\u30FC\u30B8\u672A\u63A5\u7D9A\u3067\u3059");
    await this.cdp.method(name, params, timeoutMs);
  }
  async editorLength() {
    const raw = await this.evalWithReconnect(EDITOR_LENGTH_JS);
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }
  async insertPrompt(prompt) {
    if (prompt.length > this.s.maxPromptChars) {
      throw new Error(`\u4F9D\u983C\u6587\u304C\u4E0A\u9650 ${this.s.maxPromptChars} \u6587\u5B57\u3092\u8D85\u3048\u3066\u3044\u307E\u3059 (${prompt.length} \u6587\u5B57)`);
    }
    try {
      await this.pasteViaClipboard(prompt);
      return;
    } catch (err) {
      console.log(`[paste] \u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u8CBC\u308A\u4ED8\u3051\u306B\u5931\u6557\u3001\u30C1\u30E3\u30F3\u30AF\u65B9\u5F0F\u3078\u30D5\u30A9\u30FC\u30EB\u30D0\u30C3\u30AF: ${err.message}`);
    }
    await this.insertByChunks(prompt);
  }
  async pasteViaClipboard(prompt) {
    await this.bringToFront();
    await this.grantClipboard();
    await this.focusEditor();
    await this.evalWithReconnect("window.focus(); true", 5e3);
    await this.evalWithReconnect(`navigator.clipboard.writeText(${JSON.stringify(prompt)})`, 15e3);
    for (let i = 0; i < 6; i++) {
      await this.evalWithReconnect(CLEAR_EDITOR_JS);
      await sleep(150);
      if (await this.editorLength() === 0) break;
    }
    await this.focusEditor();
    await this.evalWithReconnect("(() => { const s = getSelection(); if (!s || !document.activeElement) return; s.selectAllChildren(document.activeElement); s.collapseToEnd() })()", 1e4);
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
    await sleep(700);
    const len = Number(await this.editorLength());
    if (len < prompt.length * 0.9) throw new Error(`\u8CBC\u308A\u4ED8\u3051\u5F8C\u306E\u9577\u3055\u4E0D\u8DB3 (\u671F\u5F85 ~${prompt.length}, \u5B9F\u969B ${len})`);
  }
  async insertByChunks(prompt) {
    if (await this.editorLength() > 0) {
      await this.clearEditor();
    }
    let pos = 0;
    let chunkSize = 900;
    while (pos < prompt.length) {
      const chunk = prompt.slice(pos, pos + chunkSize);
      const expectedGrowth = Math.floor(chunk.length * 0.9);
      let ok = false;
      for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
        const before = Math.max(0, await this.editorLength());
        await this.bringToFront();
        await this.focusEditor();
        await this.cdpMethod("Input.insertText", { text: chunk });
        await sleep(300);
        const after = await this.editorLength();
        if (after - before >= expectedGrowth) ok = true;
        else await sleep(600);
      }
      if (!ok) {
        if (chunkSize <= 500) {
          throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u304C\u4F4D\u7F6E ${pos} \u3067\u53CD\u6620\u3055\u308C\u307E\u305B\u3093\u3067\u3057\u305F`);
        }
        chunkSize = Math.floor(chunkSize / 2);
        continue;
      }
      pos += chunk.length;
    }
  }
  async clearEditor() {
    await this.focusEditor();
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(200);
  }
  async focusEditor() {
    const js = `(() => {
      ${VISIBLE_JS}
      ${DOCS_JS}
      const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
      for (const d of __docs) for (const s of sels) {
        const el = d.querySelector(s);
        if (__vis(el)) { el.focus(); return 'ok'; }
      }
      return 'ng';
    })()`;
    if (await this.evalWithReconnect(js) !== "ok") throw new Error("\u5165\u529B\u6B04\u306B\u30D5\u30A9\u30FC\u30AB\u30B9\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  async clickSend() {
    const raw = await this.evalWithReconnect(CLICK_SEND_JS);
    if (!JSON.parse(String(raw)).clicked) {
      throw new Error("\u6709\u52B9\u306A\u9001\u4FE1\u30DC\u30BF\u30F3\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F");
    }
  }
  async readScreenState() {
    const raw = await this.evalWithReconnect(SCREEN_STATE_JS, 15e3);
    return JSON.parse(String(raw));
  }
  async waitResponse(baseline, signal) {
    const start = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let sawNewText = false;
    let stable = 0;
    while (Date.now() - start < this.s.responseTimeoutSec * 1e3) {
      throwIfAborted(signal);
      const st = await this.readScreenState();
      if (st.signinRequired) throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002");
      if (st.text && st.text !== baseline) {
        sawNewText = true;
        if (st.text !== lastText) {
          lastText = st.text;
          lastChange = Date.now();
          stable = 0;
        } else if (lastText !== "") {
          stable++;
        }
      }
      const hasMarker = this.s.endMarker.length > 0 && lastText.includes(this.s.endMarker);
      const quietFor = Date.now() - lastChange;
      if (sawNewText && lastText !== "" && st.text === lastText) {
        if (hasMarker && stable >= 1 && quietFor >= 1100) return await this.finalizeAnswer(lastText);
        if (!st.generating && stable >= 2 && quietFor >= 1700) return await this.finalizeAnswer(lastText);
      }
      if (!st.generating && sawNewText && quietFor > this.s.stallTimeoutSec * 1e3) {
        throw new Error("Copilot \u306E\u5FDC\u7B54\u304C\u505C\u6EDE\u3057\u305F\u305F\u3081\u8AE6\u3081\u307E\u3057\u305F");
      }
      await sleep(this.s.pollIntervalMs);
      throwIfAborted(signal);
    }
    throw new Error(`Copilot \u306E\u5FDC\u7B54\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F (${this.s.responseTimeoutSec}\u79D2)`);
  }
  cleanResponse(text) {
    return text.split("\n").filter((l) => l.trim() !== this.s.endMarker).join("\n").trim();
  }
  async selectModel() {
    if (!this.s.modelPriority || this.s.modelPriority.length === 0) return;
    const js = MODEL_SELECT_JS.replace("__CANDIDATES__", JSON.stringify(this.s.modelPriority)).replace("__SWITCHER__", JSON.stringify("#gptModeSwitcher"));
    try {
      const raw = await this.evalWithReconnect(js, 3e4);
      const r = JSON.parse(String(raw));
      if (r.changed) console.log(`[model] ${r.before ?? "?"} -> ${r.after ?? r.picked ?? "?"}`);
    } catch (err) {
      console.log(`[model] \u5207\u66FF\u30B9\u30AD\u30C3\u30D7(\u7D99\u7D9A): ${err.message}`);
    }
  }
  async complete(prompt, signal) {
    throwIfAborted(signal);
    await this.ensureEdge();
    await this.ensurePage();
    await this.freshChat();
    await this.waitInputReady(120, signal);
    await this.selectModel();
    throwIfAborted(signal);
    await this.waitInputReady(30, signal);
    await this.assertTrustedOrigin();
    await this.insertPrompt(prompt);
    await this.clickSend();
    throwIfAborted(signal);
    const baseline = (await this.readScreenState()).text;
    return this.waitResponse(baseline, signal);
  }
  close() {
    this.cdp?.close();
    this.cdp = null;
  }
};

// src/session.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));
var logPath;
function ensureLog() {
  if (!logPath) {
    const dir = import_node_path4.default.join(import_node_os.default.tmpdir(), "company-coding-agent", "sessions");
    import_node_fs3.default.mkdirSync(dir, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    logPath = import_node_path4.default.join(dir, `${stamp}.jsonl`);
  }
  return logPath;
}
function appendSession(userInput, newMessages) {
  try {
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), input: userInput, messages: newMessages }) + "\n";
    import_node_fs3.default.appendFileSync(ensureLog(), line, "utf8");
  } catch {
  }
}

// src/repl.ts
var DEFAULT_SYSTEM_PROMPT = "\u3042\u306A\u305F\u306F\u793E\u5185\u306E\u30B3\u30FC\u30C7\u30A3\u30F3\u30B0\u652F\u63F4\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3067\u3059\u3002\u63D0\u4F9B\u3055\u308C\u305F\u30C4\u30FC\u30EB\u3067\u30D5\u30A1\u30A4\u30EB\u306E\u8ABF\u67FB\u30FB\u7DE8\u96C6\u30FB\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u3092\u884C\u3044\u3001\u7C21\u6F54\u306A\u65E5\u672C\u8A9E\u3067\u56DE\u7B54\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
function printHelp() {
  console.log(
    [
      "\u30B3\u30DE\u30F3\u30C9:",
      "  /help   \u30D8\u30EB\u30D7\u8868\u793A",
      "  /reset  \u4F1A\u8A71\u5C65\u6B74\u3092\u30EA\u30BB\u30C3\u30C8",
      "  /cwd    \u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u3092\u8868\u793A",
      "  /exit   \u7D42\u4E86 (\u7A7AEnter\u3067\u3082\u7D42\u4E86)",
      "",
      "\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u306E\u524D\u306B\u78BA\u8A8D\u30D7\u30ED\u30F3\u30D7\u30C8\u304C\u8868\u793A\u3055\u308C\u307E\u3059(\u30D5\u30A1\u30A4\u30EB\u66F8\u304D\u8FBC\u307F\u306F\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5185\u306A\u3089\u81EA\u52D5\u627F\u8A8D)"
    ].join("\n")
  );
}
async function startRepl(cfg, ctx) {
  const lineQueue = [];
  let waiter = null;
  const rl = import_node_readline.default.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w("");
    }
  });
  async function nextLine(promptText) {
    process.stdout.write(promptText);
    if (lineQueue.length > 0) return lineQueue.shift();
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }
  const io = {
    print: (t) => console.log(t),
    askYesNo: async (q) => /^y(es)?$/i.test(await nextLine(`${q} [y/N]: `))
  };
  let messages = [{ role: "system", content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }];
  let copilotBackend = null;
  console.log(`coding-agent (${cfg.model || (cfg.provider ?? "openai")}) \u2014 \u958B\u59CB\u3002/help \u3067\u30B3\u30DE\u30F3\u30C9\u3001\u7A7AEnter\u3067\u7D42\u4E86`);
  for (; ; ) {
    const input = await nextLine("> ");
    if (input === "") break;
    if (input.startsWith("/")) {
      const cmd = input.split(/\s+/)[0];
      if (cmd === "/exit" || cmd === "/quit") break;
      if (cmd === "/reset") {
        messages = messages.slice(0, 1);
        console.log("(\u4F1A\u8A71\u3092\u30EA\u30BB\u30C3\u30C8\u3057\u307E\u3057\u305F)");
        continue;
      }
      if (cmd === "/cwd") {
        console.log(ctx.workspace);
        continue;
      }
      if (cmd === "/help") {
        printHelp();
        continue;
      }
      console.log(`\u4E0D\u660E\u306A\u30B3\u30DE\u30F3\u30C9: ${cmd}`);
      continue;
    }
    const backend = cfg.provider === "copilot-edge" ? copilotBackend ??= new CopilotEdgeClient(cfg) : void 0;
    const result = await runAgentTurn({ cfg, messages, userInput: input, ctx, io, backend });
    if (result.reply) console.log(result.reply + "\n");
    messages = result.messages;
    appendSession(input, result.messages);
  }
  rl.close();
  copilotBackend?.close?.();
}

// src/index.ts
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : void 0;
}
function positionalWorkspace() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--workspace") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a;
  }
  return void 0;
}
async function main() {
  const cfg = loadConfig(argValue("--config"));
  const workspaceArg = argValue("--workspace") ?? positionalWorkspace();
  const workspace = workspaceArg ? import_node_path5.default.resolve(workspaceArg) : process.cwd();
  await startRepl(cfg, { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true });
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
