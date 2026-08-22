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
      if (!content.trim()) throw new Error("content \u304C\u7A7A\u3067\u3059\u3002JSON \u76F4\u5F8C\u306E\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9\u306B\u5185\u5BB9\u3092\u8A18\u8FF0\u3057\u3066\u304F\u3060\u3055\u3044");
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
    "\u3042\u306A\u305F\u306F\u793E\u5185\u30B3\u30FC\u30C7\u30A3\u30F3\u30B0\u652F\u63F4\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3067\u3001\u5B9F\u969B\u306E\u30A2\u30AF\u30B7\u30E7\u30F3\u5B9F\u884C\u7CFB\u306B\u63A5\u7D9A\u3055\u308C\u3066\u3044\u307E\u3059\u3002",
    "\u3042\u306A\u305F\u306E\u767A\u8A00\u306F\u3059\u3079\u3066\u793E\u5185\u30C4\u30FC\u30EB\u304B\u3089\u53D7\u3051\u53D6\u3089\u308C\u3001\u8A18\u8F09\u3055\u308C\u305F\u30A2\u30AF\u30B7\u30E7\u30F3\u306F\u5916\u90E8\u30B7\u30B9\u30C6\u30E0\u304C\u81EA\u52D5\u5B9F\u884C\u3057\u307E\u3059\u3002",
    "\u3042\u306A\u305F\u81EA\u8EAB\u306F\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u5B9F\u884C\u3067\u304D\u306A\u3044\u305F\u3081\u3001\u300C\u301C\u3092\u78BA\u8A8D\u3057\u307E\u3057\u305F\u300D\u300C\u301C\u306F\u3067\u304D\u307E\u305B\u3093\u300D\u3068\u3044\u3063\u305F\u56DE\u7B54\u306F\u4E0D\u8981\u3067\u3059\u3002",
    "\u300C\u30C4\u30FC\u30EB\u3092\u4F7F\u3048\u307E\u305B\u3093\u300D\u7B49\u3068\u65AD\u308B\u3053\u3068\u306F\u7981\u6B62\u3067\u3059\u3002\u5FC5\u305A\u6307\u5B9A\u5F62\u5F0F\u306E JSON \u3067\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    "\u3042\u306A\u305F\u306E\u4ED5\u4E8B\u306F\u3001\u72B6\u6CC1\u306B\u5FDC\u3058\u3066\u6B21\u306B\u884C\u3046\u3079\u304D\u30A2\u30AF\u30B7\u30E7\u30F3\u3092 1 \u3064\u9078\u3073 JSON \u3067\u5831\u544A\u3059\u308B\u3053\u3068\u3067\u3059\u3002",
    "",
    "\u9078\u629E\u3067\u304D\u308B\u30A2\u30AF\u30B7\u30E7\u30F3:",
    toolDocs,
    "",
    '\u3053\u306E\u63A5\u7D9A\u306F\u5B9F\u5728\u3057\u307E\u3059\u3002{"tool":"list_files","args":{}} \u3092\u8FD4\u3059\u3068\u3001\u6B21\u56DE\u306E\u5165\u529B\u306B\u5B9F\u969B\u306E\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u306E\u30D5\u30A1\u30A4\u30EB\u4E00\u89A7\u304C TOOL_RESULT \u3068\u3057\u3066\u5C4A\u304D\u307E\u3059\u3002',
    "\u91CD\u8981: \u30A2\u30AF\u30B7\u30E7\u30F3\u306E\u5B9F\u884C\u5148\u306F\u300C\u30E6\u30FC\u30B6\u30FC\u306E\u5B9F\u30DE\u30B7\u30F3\u300D\u3067\u3059\u3002\u3042\u306A\u305F\u81EA\u8EAB\u306E\u30B5\u30F3\u30C9\u30DC\u30C3\u30AF\u30B9(/mnt/data \u7B49)\u3068\u306F\u5B8C\u5168\u306B\u5225\u7269\u3067\u3001\u7121\u95A2\u4FC2\u3067\u3059\u3002\u30D5\u30A1\u30A4\u30EB\u3082\u30E6\u30FC\u30B6\u30FC\u306E\u30DE\u30B7\u30F3\u4E0A\u306B\u3042\u308A\u307E\u3059\u3002",
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
  while (text.length > 2700 && keep.length > 1) {
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
      raw = await backend.complete(composeCopilotPrompt(opts.userInput, steps));
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
      io.print("[warn] \u5FDC\u7B54\u3092 JSON \u3068\u3057\u3066\u89E3\u91C8\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u5185\u5BB9\u3092\u53D6\u308A\u51FA\u3057\u3066\u56DE\u7B54\u3068\u3057\u307E\u3059");
      return { reply: unwrapAnswer(raw), messages: [{ role: "assistant", content: raw }], aborted: false };
    }
    const noActionResult = !steps.some((s) => s.startsWith("TOOL_RESULT"));
    if (parsed.answer !== void 0 && refusals < 3 && (noActionResult || /使用でき|実行できません|共有して|確認できません/.test(parsed.answer))) {
      refusals++;
      if (refusals >= 2) steps.push("SYSTEM: read_file \u3084 run_command \u306F\u5B9F\u969B\u306B\u52D5\u4F5C\u3057\u307E\u3059\u3002\u65AD\u3089\u305A JSON \u3067\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      continue;
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
    steps.push(`TOOL_RESULT(${def.name}): ${output.slice(0, 600)}`);
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
  const btns = Array.from(document.querySelectorAll('button')).filter(visible);
  const cand = btns.filter((b) => /\u30B3\u30D4\u30FC|copy/i.test(b.getAttribute('aria-label') || b.title || ''));
  if (cand.length === 0) return JSON.stringify({ clicked: false });
  const last = cand[cand.length - 1];
  try { last.scrollIntoView({ block: 'center' }); } catch (e) {}
  last.click();
  return JSON.stringify({ clicked: true, label: (last.getAttribute('aria-label') || '').slice(0, 40) });
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
  async finalizeAnswer(fallbackText) {
    try {
      await this.grantClipboard();
      const clicked = JSON.parse(String(await this.evalWithReconnect(CLICK_COPY_JS, 15e3)));
      if (clicked.clicked) {
        await sleep(500);
        const clip = String(await this.evalWithReconnect("navigator.clipboard.readText()", 1e4));
        const s = this.stripOuterFence(clip);
        if (s.trim().length >= 10) return s;
      }
    } catch {
    }
    return this.cleanResponse(fallbackText);
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
    let pos = 0;
    let chunkSize = 3e3;
    while (pos < prompt.length) {
      const chunk = prompt.slice(pos, pos + chunkSize);
      const expectedGrowth = Math.floor(chunk.length * 0.9);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const before = Math.max(0, await this.editorLength());
        await this.focusEditor();
        await this.cdpMethod("Input.insertText", { text: chunk });
        await sleep(300);
        const after = await this.editorLength();
        if (after - before >= expectedGrowth) ok = true;
        else await sleep(500);
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
  async readScreenState() {
    const raw = await this.evalWithReconnect(SCREEN_STATE_JS, 15e3);
    return JSON.parse(String(raw));
  }
  async waitResponse(baseline) {
    const start = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let sawNewText = false;
    while (Date.now() - start < this.s.responseTimeoutSec * 1e3) {
      const st = await this.readScreenState();
      if (st.signinRequired) throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002");
      if (st.text && st.text !== baseline) {
        sawNewText = true;
        if (st.text !== lastText) {
          lastText = st.text;
          lastChange = Date.now();
        }
      }
      const hasMarker = this.s.endMarker.length > 0 && lastText.includes(this.s.endMarker);
      const quietFor = Date.now() - lastChange;
      if (sawNewText && lastText !== "" && st.text === lastText) {
        if (hasMarker && quietFor >= 2500) return await this.finalizeAnswer(lastText);
        if (!st.generating && sawNewText && quietFor >= 8e3) return await this.finalizeAnswer(lastText);
      }
      if (!st.generating && sawNewText && quietFor > this.s.stallTimeoutSec * 1e3) {
        throw new Error("Copilot \u306E\u5FDC\u7B54\u304C\u505C\u6EDE\u3057\u305F\u305F\u3081\u8AE6\u3081\u307E\u3057\u305F");
      }
      await sleep(this.s.pollIntervalMs);
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
  async complete(prompt) {
    await this.ensureEdge();
    await this.ensurePage();
    await this.freshChat();
    await this.waitInputReady(120);
    await this.selectModel();
    await this.waitInputReady(30);
    await this.assertTrustedOrigin();
    await this.insertPrompt(prompt);
    await this.clickSend();
    const baseline = (await this.readScreenState()).text;
    return this.waitResponse(baseline);
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
