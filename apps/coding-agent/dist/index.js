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
var import_promises2 = __toESM(require("node:readline/promises"));

// src/llm.ts
async function chat(cfg, messages, tools) {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json" };
  const key = resolveApiKey(cfg);
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature ?? 0.2,
      messages,
      ...tools.length > 0 ? { tools } : {}
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API \u30A8\u30E9\u30FC ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message;
  if (!raw) throw new Error("LLM API \u306E\u5FDC\u7B54\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
  return {
    role: "assistant",
    content: raw.content ?? "",
    ...raw.tool_calls ? { tool_calls: raw.tool_calls } : {}
  };
}

// src/tools.ts
var import_node_child_process = require("node:child_process");
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_util = __toESM(require("node:util"));
var execAsync = import_node_util.default.promisify(import_node_child_process.exec);
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
      await import_promises.default.mkdir(import_node_path2.default.dirname(abs), { recursive: true });
      await import_promises.default.writeFile(abs, content, "utf8");
      return `\u66F8\u304D\u8FBC\u307F\u5B8C\u4E86: ${import_node_path2.default.relative(ctx.workspace, abs)} (${Buffer.byteLength(content)} bytes)`;
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
      return `\u7DE8\u96C6\u5B8C\u4E86: ${import_node_path2.default.relative(ctx.workspace, abs)} (${count} \u7B87\u6240)`;
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
    name: "run_command",
    description: "\u30B7\u30A7\u30EB\u30B3\u30DE\u30F3\u30C9\u3092\u5B9F\u884C\u3057\u6A19\u6E96\u51FA\u529B\u3068\u6A19\u6E96\u30A8\u30E9\u30FC\u3092\u8FD4\u3059 (\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8 60\u79D2)",
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
var END_MARKER = "AGENT_END";
function buildProtocolRules() {
  const toolDocs = TOOL_DEFS.map((t) => `- ${t.name}: ${t.description}
  \u5F15\u6570\u30B9\u30AD\u30FC\u30DE: ${JSON.stringify(t.parameters)}`).join("\n");
  return [
    "\u3042\u306A\u305F\u306F\u793E\u5185\u30B3\u30FC\u30C7\u30A3\u30F3\u30B0\u652F\u63F4\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3067\u3059\u3002\u4EE5\u4E0B\u306E\u30C4\u30FC\u30EB\u3067\u30D5\u30A1\u30A4\u30EB\u306E\u8ABF\u67FB\u30FB\u7DE8\u96C6\u30FB\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u304C\u3067\u304D\u307E\u3059\u3002",
    toolDocs,
    "",
    "\u5FDC\u7B54\u306F\u5FC5\u305A\u6B21\u306E\u3069\u3061\u3089\u304B\u306E\u5F62\u5F0F\u306E JSON \u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u300C1\u3064\u3060\u3051\u300D\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    '  {"tool":"<\u30C4\u30FC\u30EB\u540D>","args":{...}}',
    '  {"answer":"<\u30E6\u30FC\u30B6\u30FC\u3078\u306E\u6700\u7D42\u56DE\u7B54(\u65E5\u672C\u8A9E)>"}',
    "\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9 (```) \u3084 JSON \u4EE5\u5916\u306E\u8AAC\u660E\u6587\u306F\u7D76\u5BFE\u306B\u51FA\u529B\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
    "\u5341\u5206\u306A\u60C5\u5831\u304C\u63C3\u3063\u305F\u3089 answer \u3067\u5FDC\u7B54\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    `\u56DE\u7B54\u306E\u6700\u5F8C\u306B\u3001${END_MARKER} \u3068\u3044\u3046\u6587\u5B57\u5217\u3060\u3051\u306E\u884C\u3092\u5FC5\u305A\u8FFD\u52A0\u3057\u3066\u304F\u3060\u3055\u3044\u3002`
  ].join("\n");
}
function extractJsonReply(raw) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
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
        if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1));
      }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (typeof obj.tool === "string") {
        return { tool: obj.tool, args: obj.args ?? {} };
      }
      if (typeof obj.answer === "string") return { answer: obj.answer };
    } catch {
      continue;
    }
  }
  return null;
}
function composeCopilotPrompt(userInput, steps) {
  const parts = [buildProtocolRules(), "", "[\u4F9D\u983C]", userInput];
  for (const s of steps) parts.push("", s);
  parts.push(
    "",
    "[\u6307\u793A]",
    "\u4E0A\u8A18\u306E\u72B6\u6CC1\u3092\u8E0F\u307E\u3048\u3066\u3001\u6B21\u306B\u53D6\u308B\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u6307\u5B9A\u306E JSON \u5F62\u5F0F\u306E\u307F\u3067\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    `\u56DE\u7B54\u306E\u6700\u5F8C\u306B\u306F ${END_MARKER} \u3060\u3051\u306E\u884C\u3092\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044\u3002`
  );
  return parts.join("\n");
}
async function runCopilotTurn(opts) {
  const { cfg, ctx, io, backend } = opts;
  const steps = [];
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    let raw;
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps));
    } catch (err) {
      io.print(`[error] ${err.message}`);
      return { reply: "", messages: [{ role: "assistant", content: `[error] ${err.message}` }], aborted: true };
    }
    const parsed = extractJsonReply(raw);
    if (!parsed) {
      io.print("[warn] \u5FDC\u7B54\u3092 JSON \u3068\u3057\u3066\u89E3\u91C8\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u305D\u306E\u307E\u307E\u56DE\u7B54\u3068\u3057\u3066\u6271\u3044\u307E\u3059");
      return { reply: raw.replace(new RegExp(`^${END_MARKER}$`, "m"), "").trim(), messages: [{ role: "assistant", content: raw }], aborted: false };
    }
    if (parsed.answer !== void 0) {
      const reply = parsed.answer.trim();
      steps.push(`assistant: {"answer":"..."}`);
      return { reply, messages: [{ role: "user", content: opts.userInput }, { role: "assistant", content: reply }], aborted: false };
    }
    const def = TOOL_DEFS.find((d) => d.name === parsed.tool);
    if (!def) {
      steps.push(`TOOL_RESULT: [error] \u672A\u77E5\u306E\u30C4\u30FC\u30EB "${parsed.tool}"\u3002tool \u306F\u6B63\u78BA\u306A\u540D\u524D\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      continue;
    }
    io.print(`[tool] ${summarize(def.name, parsed.args ?? {})}`);
    if (def.kind !== "read") {
      const auto = def.kind === "write" ? cfg.autoApprove?.write : cfg.autoApprove?.command;
      if (!auto) {
        const ok = await io.askYesNo(`  \u2191 \u5B9F\u884C\u3057\u307E\u3059\u304B\uFF1F (${def.kind})`);
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
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 6e3)}`);
  }
  io.print("[warn] \u6700\u5927\u53CD\u5FA9\u56DE\u6570\u306B\u9054\u3057\u307E\u3057\u305F");
  return { reply: "", messages: [], aborted: true };
}
async function runAgentTurn(opts) {
  if (opts.backend || opts.cfg.provider === "copilot-edge") {
    const backend = opts.backend;
    if (!backend) throw new Error("provider=copilot-edge \u306B\u306F backend \u304C\u5FC5\u8981\u3067\u3059");
    return runCopilotTurn({ cfg: opts.cfg, backend, userInput: opts.userInput, ctx: opts.ctx, io: opts.io });
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
    const auto = def.kind === "write" ? cfg.autoApprove?.write : cfg.autoApprove?.command;
    if (!auto) {
      const ok = await io.askYesNo(`  \u2191 \u5B9F\u884C\u3057\u307E\u3059\u304B\uFF1F (${def.kind})`);
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

// src/copilot.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
function resolveCopilotSettings(cfg) {
  const c = cfg.copilot ?? {};
  return {
    url: c.url ?? "https://m365.cloud.microsoft/chat/",
    cdpPort: c.cdpPort ?? 9444,
    maxPromptChars: c.maxPromptChars ?? 6e4,
    pollIntervalMs: Math.max(500, c.pollIntervalMs ?? 2e3),
    responseTimeoutSec: c.responseTimeoutSec ?? 300,
    stallTimeoutSec: c.stallTimeoutSec ?? 120,
    displayMode: c.displayMode === "foreground" ? "foreground" : "minimized",
    endMarker: c.endMarker ?? "AGENT_END"
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
  const signIn = buttons.find(el => /sign\\s*in|log\\s*in|\u30B5\u30A4\u30F3\u30A4\u30F3|\u30ED\u30B0\u30A4\u30F3/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
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
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  constructor(cfg) {
    this.s = resolveCopilotSettings(cfg);
  }
  async ensureEdge() {
    if (await devToolsUp(this.s.cdpPort)) return;
    const args = [
      `--remote-debugging-port=${this.s.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${import_node_path3.default.join(process.env.APPDATA ?? process.env.USERPROFILE ?? ".", "CompanyApps", "coding-agent", "edge-profile")}`,
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate"
    ];
    if (this.s.displayMode === "minimized") args.push("--window-position=-32000,-32000", "--window-size=1280,900");
    args.push(this.s.url);
    (0, import_node_child_process2.spawn)(findEdgePath(), args, { detached: true, stdio: "ignore" }).unref();
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
    const actual = String(await this.evalWithReconnect("(() => location.origin)()"));
    const u = new URL(this.s.url);
    if (u.protocol !== "https" || !u.host) throw new Error(`copilot.url \u306F https \u306E\u7D76\u5BFE URL \u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044: ${this.s.url}`);
    const expected = `https://${u.host.toLowerCase()}`;
    if (actual.toLowerCase().split(":")[0] !== "https" || !actual.toLowerCase().includes(u.host.toLowerCase())) {
      throw new Error(`Copilot \u306E\u9001\u4FE1\u5148\u304C\u8A2D\u5B9A\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093 (expected=${expected}, actual=${actual})`);
    }
  }
  async evalWithReconnect(expr, timeoutMs = 2e4) {
    if (!this.cdp) throw new Error("Copilot \u30DA\u30FC\u30B8\u672A\u63A5\u7D9A\u3067\u3059");
    return this.cdp.evalJs(expr, timeoutMs);
  }
  async waitInputReady(timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1e3;
    while (Date.now() < deadline) {
      const raw = await this.evalWithReconnect(INPUT_READY_JS, 15e3);
      const state = JSON.parse(String(raw));
      if (/login|signin|sign-in|auth/i.test(state.url)) {
        throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002Edge \u30A6\u30A3\u30F3\u30C9\u30A6\u3067\u30B5\u30A4\u30F3\u30A4\u30F3\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      if (state.ready) return;
      await sleep(2e3);
    }
    throw new Error("Copilot \u306E\u5165\u529B\u6B04\u304C\u6E96\u5099\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F (\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8)\u3002");
  }
  async freshChat() {
    const raw = await this.evalWithReconnect(FRESH_CHAT_JS);
    if (!JSON.parse(String(raw)).clicked) {
      await this.cdpMethod("Page.navigate", { url: this.s.url });
      await sleep(3e3);
    } else {
      await sleep(800);
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
    if (await this.editorLength() > 0) {
      await this.clearEditor();
    }
    const chunkSize = 3e3;
    for (let i = 0; i < prompt.length; i += chunkSize) {
      const chunk = prompt.slice(i, i + chunkSize);
      const expectedGrowth = Math.floor(chunk.length * 0.9);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const before = Math.max(0, await this.editorLength());
        await this.cdpMethod("Input.insertText", { text: chunk });
        await sleep(300);
        const after = await this.editorLength();
        if (after - before >= expectedGrowth) ok = true;
        else await sleep(500);
      }
      if (!ok) throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u304C\u4F4D\u7F6E ${i} \u3067\u53CD\u6620\u3055\u308C\u307E\u305B\u3093\u3067\u3057\u305F`);
    }
    const len = await this.editorLength();
    if (len < prompt.length * 0.9) throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F (\u671F\u5F85 ${prompt.length} / \u5B9F\u969B ${len})`);
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
  async waitResponse() {
    const start = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let sawAnyText = false;
    while (Date.now() - start < this.s.responseTimeoutSec * 1e3) {
      const raw = await this.evalWithReconnect(SCREEN_STATE_JS, 15e3);
      const st = JSON.parse(String(raw));
      if (st.signinRequired) throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002");
      if (st.text !== lastText) {
        if (st.text) sawAnyText = true;
        lastText = st.text;
        lastChange = Date.now();
      }
      const hasMarker = this.s.endMarker.length > 0 && lastText.includes(this.s.endMarker);
      const quietFor = Date.now() - lastChange;
      if (hasMarker && quietFor >= 2500) return this.cleanResponse(lastText);
      if (!st.generating && sawAnyText && quietFor >= 8e3) return this.cleanResponse(lastText);
      if (!st.generating && sawAnyText && quietFor > this.s.stallTimeoutSec * 1e3) {
        throw new Error("Copilot \u306E\u5FDC\u7B54\u304C\u505C\u6EDE\u3057\u305F\u305F\u3081\u8AE6\u3081\u307E\u3057\u305F");
      }
      await sleep(this.s.pollIntervalMs);
    }
    throw new Error(`Copilot \u306E\u5FDC\u7B54\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F (${this.s.responseTimeoutSec}\u79D2)`);
  }
  cleanResponse(text) {
    return text.split("\n").filter((l) => l.trim() !== this.s.endMarker).join("\n").trim();
  }
  async complete(prompt) {
    await this.ensureEdge();
    await this.ensurePage();
    await this.assertTrustedOrigin();
    await this.freshChat();
    await this.waitInputReady(120);
    await this.insertPrompt(prompt);
    await this.clickSend();
    return this.waitResponse();
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
      "\u30D5\u30A1\u30A4\u30EB\u66F8\u304D\u8FBC\u307F\u30FB\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u306E\u524D\u306B\u78BA\u8A8D\u30D7\u30ED\u30F3\u30D7\u30C8\u304C\u8868\u793A\u3055\u308C\u307E\u3059"
    ].join("\n")
  );
}
async function startRepl(cfg, ctx) {
  const io = {
    print: (t) => console.log(t),
    askYesNo: async (q) => {
      const rl2 = import_promises2.default.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl2.question(`${q} [y/N]: `)).trim());
      } finally {
        rl2.close();
      }
    }
  };
  let messages = [{ role: "system", content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }];
  let copilotBackend = null;
  console.log(`coding-agent (${cfg.model || (cfg.provider ?? "openai")}) \u2014 \u958B\u59CB\u3002/help \u3067\u30B3\u30DE\u30F3\u30C9\u3001\u7A7AEnter\u3067\u7D42\u4E86`);
  const rl = import_promises2.default.createInterface({ input: process.stdin, output: process.stdout });
  for (; ; ) {
    const input = (await rl.question("> ")).trim();
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
