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

// test/smoke.ts
var import_node_assert = __toESM(require("node:assert"));
var import_node_http2 = __toESM(require("node:http"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// src/llm.ts
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));

// src/config.ts
function resolveApiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  return process.env[cfg.apiKeyEnv ?? "COMPANY_LLM_API_KEY"];
}

// src/llm.ts
function postJson(url, body, headers) {
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
    req.on("error", reject);
    req.end(body);
  });
}
async function chat(cfg, messages, tools) {
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
  const res = await postJson(url, payload, headers);
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
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
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
  const abs = import_node_path.default.isAbsolute(p) ? import_node_path.default.normalize(p) : import_node_path.default.resolve(ctx.workspace, p);
  if (ctx.restrictToWorkspace && import_node_path.default.relative(ctx.workspace, abs).startsWith("..")) {
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
    const full = import_node_path.default.join(dir, e.name);
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
        if (!re || re.test(import_node_path.default.basename(f))) out.push(import_node_path.default.relative(ctx.workspace, f).replaceAll("\\", "/"));
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
      await import_promises.default.mkdir(import_node_path.default.dirname(abs), { recursive: true });
      await import_promises.default.writeFile(abs, content, "utf8");
      return `\u66F8\u304D\u8FBC\u307F\u5B8C\u4E86: ${import_node_path.default.relative(ctx.workspace, abs)} (${Buffer.byteLength(content)} bytes)`;
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
      await import_promises.default.writeFile(abs, next, "utf8");
      return `\u7DE8\u96C6\u5B8C\u4E86: ${import_node_path.default.relative(ctx.workspace, abs)} (${count} \u7B87\u6240)`;
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
            results.push(`${import_node_path.default.relative(ctx.workspace, f).replaceAll("\\", "/")}:${i + 1}: ${truncate(lines[i], 300)}`);
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
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspace,
          timeout: 6e4,
          maxBuffer: 1024 * 1024,
          windowsHide: true
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
function extractJsonReply(raw) {
  return extractReplyAndEnd(raw)?.parsed ?? null;
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
  if (cfg.copilot?.agentMode !== true) {
    const prompt = [cfg.systemPrompt, opts.userInput].filter((s) => s && s.trim()).join("\n\n");
    try {
      const text = (await backend.complete(prompt)).trim();
      return { reply: text, messages: [...opts.messages, { role: "user", content: opts.userInput }, { role: "assistant", content: text }], aborted: false };
    } catch (err) {
      const msg = err.message;
      io.print(`[error] ${msg}`);
      return { reply: "", messages: [{ role: "assistant", content: `[error] ${msg}` }], aborted: true };
    }
  }
  const steps = [];
  try {
    const listDef = TOOL_DEFS.find((d) => d.name === "list_files");
    steps.push(`TOOL_RESULT(list_files): ${(await listDef.run({}, ctx)).slice(0, 600)}`);
  } catch {
  }
  let parseRetried = false;
  let refusals = 0;
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    let raw;
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps, opts.cfg.copilot?.maxPromptChars ?? 12e4, history));
      raw = raw.replace(/＜/g, "<").replace(/＞/g, ">").replace(new RegExp(String.fromCharCode(65312) === "" ? "" : "\uFF40", "g"), String.fromCharCode(96));
    } catch (err) {
      io.print(`[error] ${err.message}`);
      return { reply: "", messages: [{ role: "assistant", content: `[error] ${err.message}` }], aborted: true };
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
      return { reply: fallback, messages: [...opts.messages, { role: "user", content: opts.userInput }, { role: "assistant", content: fallback }], aborted: false };
    }
    if (parsed.answer !== void 0 && refusals < 3 && /使用でき|実行できません|共有して|確認できません|アップロードして/.test(parsed.answer)) {
      refusals++;
      if (refusals >= 2) steps.push("SYSTEM: read_file \u3084 run_command \u306F\u5B9F\u969B\u306B\u52D5\u4F5C\u3057\u307E\u3059\u3002\u65AD\u3089\u305A JSON \u3067\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      continue;
    }
    if (parsed.answer !== void 0) {
      const reply = parsed.answer.trim();
      steps.push(`assistant: {"answer":"..."}`);
      return { reply, messages: [...opts.messages, { role: "user", content: opts.userInput }, { role: "assistant", content: reply }], aborted: false };
    }
    const def = TOOL_DEFS.find((d) => d.name === parsed.tool);
    if (!def) {
      steps.push(`TOOL_RESULT: [error] \u672A\u77E5\u306E\u30C4\u30FC\u30EB "${parsed.tool}"\u3002tool \u306F\u6B63\u78BA\u306A\u540D\u524D\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      continue;
    }
    io.print(`[tool] ${summarize(def.name, parsed.args ?? {})}`);
    if (def.kind !== "read") {
      const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
      if (!auto) {
        const ok = await io.askYesNo(`\u5B9F\u884C\u3092\u8A31\u53EF\u3057\u307E\u3059\u304B\uFF1F
${summarize(def.name, parsed.args ?? {})}`);
        if (!ok) {
          steps.push(`TOOL_RESULT(${def.name}): (\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F)`);
          continue;
        }
      }
    }
    let output;
    try {
      output = await def.run(parsed.args ?? {}, ctx);
    } catch (err) {
      output = `[tool error] ${err.message}`;
    }
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 2e3)}`);
  }
  io.print("[warn] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F");
  return { reply: "", messages: [], aborted: true };
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
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    let assistant;
    try {
      assistant = await chat(cfg, messages, openAITools());
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
      const output = await executeCall(call, cfg, ctx, io);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output });
    }
  }
  io.print("[warn] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F");
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
  io.print(`[tool] ${summarize(def.name, args)}`);
  if (def.kind !== "read") {
    const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
    if (!auto) {
      const ok = await io.askYesNo(`\u5B9F\u884C\u3092\u8A31\u53EF\u3057\u307E\u3059\u304B\uFF1F
${summarize(def.name, args)}`);
      if (!ok) return "(\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F)";
    }
  }
  try {
    return await def.run(args, ctx);
  } catch (err) {
    return `[tool error] ${err.message}`;
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

// src/approvals.ts
var pending = /* @__PURE__ */ new Map();
var sequence2 = 0;
var APPROVAL_TIMEOUT_MS = 10 * 60 * 1e3;
function makeId2() {
  sequence2 = (sequence2 + 1) % 1048576;
  return `approval-${Date.now().toString(36)}-${sequence2.toString(36)}`;
}
function requestApproval(question) {
  const id = makeId2();
  const createdAt = Date.now();
  return new Promise((resolve) => {
    const entry = { id, question, createdAt, resolve };
    pending.set(id, entry);
    setTimeout(() => {
      const current = pending.get(id);
      if (current !== entry) return;
      pending.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS).unref();
  });
}
function listApprovals() {
  return [...pending.values()].sort((a, b) => a.createdAt - b.createdAt).map(({ id, question, createdAt }) => ({ id, question, createdAt }));
}
function resolveApproval(id, approved) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(Boolean(approved));
  return true;
}

// test/smoke.ts
function makeCtx(root, restrict = true) {
  return { workspace: root, restrictToWorkspace: restrict };
}
function ioStub(approve) {
  return {
    print: () => {
    },
    askYesNo: async () => approve
  };
}
async function testApprovals() {
  const pending2 = requestApproval("approve smoke");
  const listed = listApprovals();
  import_node_assert.default.strictEqual(listed.length, 1);
  import_node_assert.default.strictEqual(listed[0].question, "approve smoke");
  import_node_assert.default.strictEqual(resolveApproval(listed[0].id, true), true);
  import_node_assert.default.strictEqual(await pending2, true);
  import_node_assert.default.strictEqual(listApprovals().length, 0);
  import_node_assert.default.strictEqual(resolveApproval("missing-approval", false), false);
  console.log("PASS approvals");
}
async function testTools() {
  const root = import_node_fs.default.mkdtempSync(import_node_path2.default.join(import_node_os.default.tmpdir(), "ca-smoke-"));
  const ctx = makeCtx(root);
  const get = (n) => TOOL_DEFS.find((t) => t.name === n);
  await get("write_file").run({ path: "a/hello.txt", content: "line1\nline2 unique\n" }, ctx);
  const read = await get("read_file").run({ path: "a/hello.txt" }, ctx);
  import_node_assert.default.ok(read.includes("unique"));
  const edited = await get("edit_file").run({ path: "a/hello.txt", old_string: "unique", new_string: "edited" }, ctx);
  import_node_assert.default.ok(edited.includes("1 \u7B87\u6240"));
  const after = await get("read_file").run({ path: "a/hello.txt" }, ctx);
  import_node_assert.default.ok(after.includes("edited"));
  import_node_assert.default.ok(!after.includes("unique"));
  const search = await get("search_files").run({ query: "edited" }, ctx);
  import_node_assert.default.ok(search.includes("hello.txt"));
  const list = await get("list_files").run({ glob: "*.txt" }, ctx);
  import_node_assert.default.ok(list.includes("hello.txt"));
  const cmd = await get("run_command").run({ command: "echo smoke-ok" }, ctx);
  import_node_assert.default.ok(cmd.includes("smoke-ok"));
  const started = JSON.parse(await get("start_process").run({
    command: `node -e "console.log('process-smoke'); setTimeout(() => {}, 10000)"`,
    label: "smoke preview"
  }, ctx));
  import_node_assert.default.ok(started.id && started.status === "running");
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const processLog = JSON.parse(await get("read_process_log").run({ process_id: started.id }, ctx));
    import_node_assert.default.ok(processLog.lines.join("\n").includes("process-smoke"));
    import_node_assert.default.ok(processLog.nextOffset >= processLog.lines.length);
    const stopped = JSON.parse(await get("stop_process").run({ process_id: started.id }, ctx));
    import_node_assert.default.ok(["stopped", "exited"].includes(stopped.status));
  } finally {
    try {
      await get("stop_process").run({ process_id: started.id }, ctx);
    } catch {
    }
  }
  let outsideThrew = false;
  try {
    await get("read_file").run({ path: "..\\outside.txt" }, ctx);
  } catch {
    outsideThrew = true;
  }
  import_node_assert.default.ok(outsideThrew, "restrict guard should throw");
  let dupThrew = false;
  try {
    await get("edit_file").run({ path: "a/hello.txt", old_string: "e", new_string: "X" }, ctx);
  } catch (err) {
    dupThrew = String(err.message).includes("\u4EF6\u4E00\u81F4");
  }
  import_node_assert.default.ok(dupThrew, "multi-match should throw without replace_all");
  import_node_fs.default.rmSync(root, { recursive: true, force: true });
  console.log("PASS tools");
}
function mockServer(steps) {
  const state = { requests: 0 };
  const server = import_node_http2.default.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      JSON.parse(body);
      state.requests++;
      const step = steps[state.requests - 1] ?? steps[steps.length - 1];
      const message = step.tool_call ? {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `call_${state.requests}`,
            type: "function",
            function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.args) }
          }
        ]
      } : { role: "assistant", content: step.content ?? "ok" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/v1`, requests: state.requests });
    });
  });
}
async function withServer(steps, fn) {
  const { server, url } = await mockServer(steps);
  try {
    await fn({ baseURL: url, model: "mock" });
  } finally {
    server.close();
  }
}
async function testAgentLoop() {
  const root = import_node_fs.default.mkdtempSync(import_node_path2.default.join(import_node_os.default.tmpdir(), "ca-smoke-"));
  await withServer(
    [
      { tool_call: { name: "write_file", args: { path: "hello.txt", content: "hi from mock" } } },
      { content: "\u66F8\u304D\u8FBC\u307F\u307E\u3057\u305F" }
    ],
    async (cfg) => {
      const result = await runAgentTurn({
        cfg,
        messages: [],
        userInput: "\u4F5C\u3063\u3066",
        ctx: makeCtx(root),
        io: ioStub(true)
      });
      import_node_assert.default.strictEqual(result.reply, "\u66F8\u304D\u8FBC\u307F\u307E\u3057\u305F");
      import_node_assert.default.strictEqual(result.aborted, false);
      const toolMsg = result.messages.find((m) => m.role === "tool");
      import_node_assert.default.ok(toolMsg && toolMsg.content && toolMsg.content.includes("\u66F8\u304D\u8FBC\u307F\u5B8C\u4E86"));
      import_node_assert.default.ok(import_node_fs.default.readFileSync(import_node_path2.default.join(root, "hello.txt"), "utf8").includes("hi from mock"));
    }
  );
  import_node_fs.default.rmSync(root, { recursive: true, force: true });
  console.log("PASS agent-loop");
}
async function testDenial() {
  await withServer(
    [{ tool_call: { name: "run_command", args: { command: "echo x" } } }, { content: "\u4E2D\u6B62\u3057\u307E\u3057\u305F" }],
    async (cfg) => {
      const result = await runAgentTurn({
        cfg,
        messages: [],
        userInput: "\u8D70\u3063\u3066",
        ctx: makeCtx(import_node_os.default.tmpdir(), false),
        io: ioStub(false)
      });
      import_node_assert.default.strictEqual(result.reply, "\u4E2D\u6B62\u3057\u307E\u3057\u305F");
      import_node_assert.default.ok(
        result.messages.some((m) => m.role === "tool" && m.content === "(\u30E6\u30FC\u30B6\u30FC\u304C\u62D2\u5426\u3057\u307E\u3057\u305F)")
      );
    }
  );
  console.log("PASS denial");
}
async function testProtocolParsing() {
  import_node_assert.default.strictEqual(extractJsonReply('{"answer":"hi"}')?.answer, "hi");
  const fenced = extractJsonReply('\u8AAC\u660E\u6587\n```json\n{"tool":"read_file","args":{"path":"a.txt"}}\n```\nAGENT_END');
  import_node_assert.default.ok(fenced && fenced.tool === "read_file" && fenced.args && fenced.args.path === "a.txt");
  const prose = extractJsonReply('\u524D\u7F6E\u304D\n{"answer":"\u6CE2\u62EC\u5F27 } \u3092\u542B\u3080\u56DE\u7B54"}\nAGENT_END');
  import_node_assert.default.strictEqual(prose?.answer, "\u6CE2\u62EC\u5F27 } \u3092\u542B\u3080\u56DE\u7B54");
  const toolNoArgs = extractJsonReply('{"tool":"list_files"}');
  import_node_assert.default.ok(toolNoArgs && toolNoArgs.tool === "list_files" && toolNoArgs.args);
  import_node_assert.default.strictEqual(extractJsonReply("\u3053\u308C\u306FJSON\u3067\u306F\u3042\u308A\u307E\u305B\u3093"), null);
  console.log("PASS protocol-parsing");
}
var FakeBackend = class {
  constructor(replies) {
    this.replies = replies;
  }
  name = "fake";
  calls = 0;
  prompts = [];
  async complete(prompt) {
    this.prompts.push(prompt);
    const r = this.replies[this.calls];
    this.calls++;
    return r ?? '{"answer":"no script"}';
  }
};
async function testCopilotLoop() {
  const root = import_node_fs.default.mkdtempSync(import_node_path2.default.join(import_node_os.default.tmpdir(), "ca-smoke-"));
  const backend = new FakeBackend([
    '```json\n{"tool":"write_file","args":{"path":"b.txt","content":"from copilot"}}\n```\nAGENT_END',
    '{"answer":"\u5B8C\u4E86\u3057\u307E\u3057\u305F"}\nAGENT_END'
  ]);
  const cfg = { baseURL: "", model: "", provider: "copilot-edge", autoApprove: { write: true }, copilot: { agentMode: true } };
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: "\u4F5C\u3063\u3066",
    ctx: makeCtx(root),
    io: ioStub(true),
    backend
  });
  import_node_assert.default.strictEqual(result.reply, "\u5B8C\u4E86\u3057\u307E\u3057\u305F");
  import_node_assert.default.strictEqual(result.aborted, false);
  import_node_assert.default.ok(import_node_fs.default.readFileSync(import_node_path2.default.join(root, "b.txt"), "utf8").includes("from copilot"));
  import_node_assert.default.strictEqual(backend.calls, 2);
  import_node_assert.default.ok(backend.prompts[1].includes("TOOL_RESULT(write_file)"));
  import_node_assert.default.ok(backend.prompts[0].includes("AGENT_END"));
  import_node_fs.default.rmSync(root, { recursive: true, force: true });
  console.log("PASS copilot-loop");
}
async function testCopilotPlainMode() {
  const backend = new FakeBackend(["\u3053\u308C\u306F\u5E73\u6587\u306E\u56DE\u7B54\u3067\u3059"]);
  const cfg = { baseURL: "", model: "", provider: "copilot-edge", systemPrompt: "SYS" };
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: "\u8CEA\u554F",
    ctx: makeCtx(import_node_os.default.tmpdir(), false),
    io: ioStub(true),
    backend
  });
  import_node_assert.default.strictEqual(result.reply, "\u3053\u308C\u306F\u5E73\u6587\u306E\u56DE\u7B54\u3067\u3059");
  import_node_assert.default.strictEqual(backend.calls, 1);
  import_node_assert.default.ok(backend.prompts[0].includes("SYS") && backend.prompts[0].includes("\u8CEA\u554F"));
  console.log("PASS copilot-plain");
}
async function testCopilotFenceMode() {
  const root = import_node_fs.default.mkdtempSync(import_node_path2.default.join(import_node_os.default.tmpdir(), "ca-smoke-"));
  const backend = new FakeBackend([
    '{"tool":"write_file","args":{"path":"fence.html"}}\n```html\n<p>fence ok</p>\n```\nAGENT_END',
    '{"answer":"\u30D5\u30A7\u30F3\u30B9\u5B8C\u4E86"}\nAGENT_END'
  ]);
  const cfg = { baseURL: "", model: "", provider: "copilot-edge", autoApprove: { write: true }, copilot: { agentMode: true } };
  const result = await runAgentTurn({
    cfg,
    messages: [],
    userInput: "\u4F5C\u3063\u3066",
    ctx: makeCtx(root),
    io: ioStub(true),
    backend
  });
  import_node_assert.default.strictEqual(result.reply, "\u30D5\u30A7\u30F3\u30B9\u5B8C\u4E86");
  import_node_assert.default.ok(import_node_fs.default.readFileSync(import_node_path2.default.join(root, "fence.html"), "utf8").includes("<p>fence ok</p>"));
  import_node_fs.default.rmSync(root, { recursive: true, force: true });
  console.log("PASS copilot-fence");
}
(async () => {
  await testApprovals();
  await testTools();
  await testAgentLoop();
  await testDenial();
  await testProtocolParsing();
  await testCopilotLoop();
  await testCopilotPlainMode();
  await testCopilotFenceMode();
  console.log("ALL PASS");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
