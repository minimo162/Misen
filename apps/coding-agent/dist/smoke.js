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
var import_node_child_process = require("node:child_process");
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
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
    const body = cm[1].split(END_MARKER)[0].replace(/\s+$/, "").replace(/＜/g, "<").replace(/＞/g, ">");
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
  const toolDocs = TOOL_DEFS.map((t) => `- ${t.name}: ${t.description}
  \u5F15\u6570\u30B9\u30AD\u30FC\u30DE: ${JSON.stringify(t.parameters)}`).join("\n");
  return [
    "\u3053\u308C\u304B\u3089\u300C\u793E\u5185\u30B3\u30FC\u30C7\u30A3\u30F3\u30B0\u652F\u63F4\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u300D\u306E\u30ED\u30FC\u30EB\u30D7\u30EC\u30A4\u3092\u304A\u9858\u3044\u3057\u307E\u3059\u3002",
    "\u3042\u306A\u305F\u306E\u767A\u8A00\u306F\u3059\u3079\u3066\u793E\u5185\u30C4\u30FC\u30EB\u304B\u3089\u53D7\u3051\u53D6\u3089\u308C\u3001\u8A18\u8F09\u3055\u308C\u305F\u30A2\u30AF\u30B7\u30E7\u30F3\u306F\u5916\u90E8\u30B7\u30B9\u30C6\u30E0\u304C\u81EA\u52D5\u5B9F\u884C\u3057\u307E\u3059\u3002",
    "\u3042\u306A\u305F\u81EA\u8EAB\u306F\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u5B9F\u884C\u3067\u304D\u306A\u3044\u305F\u3081\u3001\u300C\u301C\u3092\u78BA\u8A8D\u3057\u307E\u3057\u305F\u300D\u300C\u301C\u306F\u3067\u304D\u307E\u305B\u3093\u300D\u3068\u3044\u3063\u305F\u56DE\u7B54\u306F\u4E0D\u8981\u3067\u3059\u3002",
    "\u3042\u306A\u305F\u306E\u4ED5\u4E8B\u306F\u3001\u72B6\u6CC1\u306B\u5FDC\u3058\u3066\u6B21\u306B\u884C\u3046\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092 1 \u3064\u9078\u3073 JSON \u3067\u5831\u544A\u3059\u308B\u3053\u3068\u3067\u3059\u3002",
    "",
    "\u9078\u629E\u3067\u304D\u308B\u30A2\u30AF\u30B7\u30E7\u30F3:",
    toolDocs,
    "",
    "\u51FA\u529B\u30EB\u30FC\u30EB(\u53B3\u5B88): \u6BCE\u56DE\u3001\u6B21\u306E\u3069\u3061\u3089\u304B\u306E JSON \u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u300C1\u3064\u3060\u3051\u300D\u3092\u51FA\u529B\u3059\u308B\u3002",
    '  {"tool":"<\u30A2\u30AF\u30B7\u30E7\u30F3\u540D>","args":{...}}',
    '  {"answer":"<\u30E6\u30FC\u30B6\u30FC\u3078\u306E\u6700\u7D42\u56DE\u7B54(\u65E5\u672C\u8A9E)>"}',
    "JSON \u4EE5\u5916\u306E\u6587\u7AE0\u30FB\u898B\u51FA\u3057\u30FB\u6328\u62F6\u306F\u4E00\u5207\u51FA\u529B\u3057\u306A\u3044\u3002",
    "write_file \u3067\u30D5\u30A1\u30A4\u30EB\u5185\u5BB9\u3092\u6E21\u3059\u3068\u304D\u306F\u3001content \u3092 JSON \u5185\u306B\u66F8\u304B\u305A\u3001JSON \u306E\u76F4\u5F8C\u306B\u300CCONTENT:\u300D\u306E\u884C\u3068\u672C\u6587\u3092\u7D9A\u3051\u3066\u304F\u3060\u3055\u3044:",
    '  {"tool":"write_file","args":{"path":"index.html"}}',
    "  CONTENT:",
    "  <p>\u3053\u3053\u306B\u30D5\u30A1\u30A4\u30EB\u672C\u6587(\u751F\u30C6\u30AD\u30B9\u30C8\u305D\u306E\u307E\u307E)</p>",
    "  AGENT_END",
    "\u300CCONTENT:\u300D\u306E\u6B21\u306E\u884C\u304B\u3089 AGENT_END \u306E\u76F4\u524D\u307E\u3067\u304C\u30D5\u30A1\u30A4\u30EB\u672C\u6587\u306B\u306A\u308A\u307E\u3059\u3002",
    '\u26A0\uFE0F \u672C\u6587\u306B\u542B\u307E\u308C\u308B\u534A\u89D2\u306E < \u3068 > \u306F\u3001\u305D\u308C\u305E\u308C\u5168\u89D2\u306E \uFF1C \u3068 \uFF1E \u306B\u7F6E\u304D\u63DB\u3048\u3066\u66F8\u3044\u3066\u304F\u3060\u3055\u3044(\u30B7\u30B9\u30C6\u30E0\u5074\u3067\u81EA\u52D5\u5FA9\u5143\u3057\u307E\u3059)\u3002\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9(```)\u306F\u4F7F\u308F\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002\u3054\u304F\u77ED\u3044\u5185\u5BB9\u3060\u3051 JSON \u5185\u306B\u66F8\u304F\u5834\u5408\u306F\u4E8C\u91CD\u5F15\u7528\u7B26\u3092 \\" \u3068\u30A8\u30B9\u30B1\u30FC\u30D7\u3057\u3066\u304F\u3060\u3055\u3044\u3002',
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
function composeCopilotPrompt(userInput, steps) {
  const head = [buildProtocolRules(), "", "[\u4F9D\u983C]", userInput];
  const tail = [
    "",
    "[\u6307\u793A]",
    "\u4E0A\u8A18\u306E\u72B6\u6CC1\u3092\u8E0F\u307E\u3048\u3066\u3001\u6B21\u306B\u53D6\u308B\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u6307\u5B9A\u306E JSON \u5F62\u5F0F\u306E\u307F\u3067\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    `\u56DE\u7B54\u306E\u6700\u5F8C\u306B\u306F ${END_MARKER} \u3060\u3051\u306E\u884C\u3092\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044\u3002`
  ];
  let keep = steps;
  const build = (list, omitted) => [...head, ...omitted ? ["(\u203B \u53E4\u3044\u7D4C\u904E\u306F\u7701\u7565\u3057\u307E\u3057\u305F)"] : [], ...list, ...tail].join("\n");
  let text = build(keep, false);
  while (text.length > 2600 && keep.length > 0) {
    keep = keep.slice(1);
    text = build(keep, true);
  }
  return text;
}
async function runCopilotTurn(opts) {
  const { cfg, ctx, io, backend } = opts;
  if (cfg.copilot?.agentMode !== true) {
    const prompt = [cfg.systemPrompt, opts.userInput].filter((s) => s && s.trim()).join("\n\n");
    try {
      const text = (await backend.complete(prompt)).trim();
      return { reply: text, messages: [{ role: "user", content: opts.userInput }, { role: "assistant", content: text }], aborted: false };
    } catch (err) {
      const msg = err.message;
      io.print(`[error] ${msg}`);
      return { reply: "", messages: [{ role: "assistant", content: `[error] ${msg}` }], aborted: true };
    }
  }
  const steps = [];
  let parseRetried = false;
  const maxIter = cfg.maxToolIterations ?? 15;
  for (let i = 0; i < maxIter; i++) {
    let raw;
    try {
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps));
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
      io.print("[warn] \u5FDC\u7B54\u3092 JSON \u3068\u3057\u3066\u89E3\u91C8\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u5185\u5BB9\u3092\u53D6\u308A\u51FA\u3057\u3066\u56DE\u7B54\u3068\u3057\u307E\u3059");
      return { reply: unwrapAnswer(raw), messages: [{ role: "assistant", content: raw }], aborted: false };
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
      const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
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
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 800)}`);
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
    const auto = def.kind === "write" ? cfg.autoApprove?.write ?? true : cfg.autoApprove?.command ?? false;
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
