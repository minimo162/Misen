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

// test/completion-policy.ts
var import_strict = __toESM(require("node:assert/strict"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));

// src/completion-policy.ts
var PATH_EXTENSIONS = [
  "xlsx",
  "xlsm",
  "json",
  "html",
  "jsx",
  "tsx",
  "yaml",
  "toml",
  "xml",
  "log",
  "text",
  "csv",
  "md",
  "pdf",
  "js",
  "ts",
  "ps1",
  "cmd",
  "bat",
  "yml",
  "txt",
  "xls"
];
var PATH_EXTENSION_PATTERN = new RegExp(`\\.(${PATH_EXTENSIONS.join("|")})(?![A-Za-z0-9_-])`, "giu");
var ASCII_PATH_SUFFIX_PATTERN = new RegExp(
  `(?:\\.{0,2}[\\\\/])?[A-Za-z0-9_*.-]+(?:[\\\\/][A-Za-z0-9_*.-]+)*\\.(?:${PATH_EXTENSIONS.join("|")})$`,
  "iu"
);
var READ_CONTENT_PATTERN = /(?:\bread\b|inspect|examine|view|open\s+(?:the\s+)?(?:file|document|workbook|README)|check\s+(?:the\s+)?(?:file|document|content)|読む|読み|読んで|閲覧|比較)/iu;
var LIST_PATTERN = /(?:\blist\b|enumerate|一覧|列挙)/iu;
var SEARCH_PATTERN = /(?:\bsearch\b|\bfind\b|look\s*up|lookup|検索|探(?:す|して|したい))/iu;
var WRITE_PATTERN = /(?:\bwrite\b|\bcreate\b|\bmake\b|\bedit\b|\bupdate\b|\bmodify\b|\bsave\b|\bdelete\b|\bremove\b|\bappend\b|\badd\b|\bgenerate\b|\bdraft\b|\boverwrite\b|\brename\b|作(?:成|る|って|りたい)|書(?:く|き|いて|け)|生成|編集|更新|変更|保存|削除|追加|報告|出力|反映)/iu;
var MULTI_ACTION_PATTERN = /(?:\band\b|\bthen\b|\balso\b|\bafter\b|\bfollowed\s+by\b|と|や|および|及び|ならびに|かつ|してから|した後|その後|さらに|また|、)/iu;
var COMMAND_PATTERN = /(?:\brun\b|\bexecute\b|\bexec\b|\bcommand\b|\bshell\b|\bterminal\b|\bprocess\b|\bstart\b|\bstop\b|\bkill\b|\blaunch\b|\bspawn\b|\bnetwork\b|\bfetch\b|\bdownload\b|\binstall\b|\bcurl\b|\bwget\b|\bnpm\b|\bpnpm\b|\byarn\b|\bbun\b|\bgit\b|実行|コマンド|シェル|ターミナル|プロセス|起動|停止|終了|ネットワーク|接続|ダウンロード|インストール|ブラウザ|外部(?:サイト|URL|サービス)|リファクタ|ビルド)/iu;
var VERIFICATION_PATTERN = /(?:\b(?:verify|verification|test|testing|build|coding|implement|refactor)\b|検証|テスト|実装|リファクタ|ビルド|動作確認)/iu;
var DESTINATION_BEFORE_PATTERN = /(?:\b(?:to|into|onto|save\s+to|write\s+to|report\s+to)\b)\s*$/iu;
var DESTINATION_AFTER_PATTERN = /^(?:へ|に)(?:保存|出力|反映|報告)?/u;
function normalize(value) {
  return value.normalize("NFKC").toLowerCase();
}
function canonicalPath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+/gu, "/").replace(/\/$/u, "").toLowerCase();
}
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
function extractPathLikeTargets(input) {
  return unique(extractPathTokens(normalize(input)).map((token) => token.value));
}
function extractPathTokens(text) {
  const tokens = [];
  PATH_EXTENSION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PATH_EXTENSION_PATTERN)) {
    const extensionStart = match.index ?? 0;
    const extensionLength = match[0].length;
    let boundary = extensionStart - 1;
    while (boundary >= 0 && !/[\s"'`([{、。！？]/u.test(text[boundary] ?? "")) boundary--;
    let start = boundary + 1;
    const prefix = text.slice(start, extensionStart);
    const particle = prefix.match(/[をにへとやのがはもで](?=[A-Za-z0-9_*?.-])/gu);
    if (particle?.length) {
      const last = particle[particle.length - 1];
      const particleIndex = prefix.lastIndexOf(last);
      if (particleIndex >= 0) start += particleIndex + last.length;
    }
    const value = text.slice(start, extensionStart + extensionLength).replace(/[),;:!?。！？]+$/u, "");
    if (!value) continue;
    const guarded = value.match(ASCII_PATH_SUFFIX_PATTERN)?.[0] ?? value;
    const index = extensionStart + extensionLength - guarded.length;
    tokens.push({ value: canonicalPath(guarded), index, length: guarded.length, pattern: /[*?]/u.test(guarded) });
  }
  return tokens;
}
function splitClauses(text) {
  return text.split(/(?:\b(?:and|then|also|but|plus|afterwards?|followed\s+by)\b|[,&;|]+|\r?\n|、|。|(?:してから|した後|その後|さらに|また|および|及び|ならびに|かつ))/u).map((clause) => clause.trim()).filter(Boolean);
}
function clauseForToken(text, token) {
  const clauses = splitClauses(text);
  let offset = 0;
  for (const clause of clauses) {
    const index = text.indexOf(clause, offset);
    if (index >= 0 && token.index >= index && token.index <= index + clause.length) return clause;
    offset = Math.max(offset, index + clause.length);
  }
  return text;
}
function isDestination(text, token) {
  const before = text.slice(Math.max(0, token.index - 80), token.index);
  const after = text.slice(token.index + token.length, token.index + token.length + 24);
  return DESTINATION_BEFORE_PATTERN.test(before) || DESTINATION_AFTER_PATTERN.test(after);
}
function classifyRoles(text, tokens) {
  const sources = [];
  const outputs = [];
  for (const token of tokens) {
    const clause = clauseForToken(text, token);
    const clauseReads = READ_CONTENT_PATTERN.test(clause);
    const clauseWrites = WRITE_PATTERN.test(clause);
    if (isDestination(text, token) || clauseWrites && !clauseReads) outputs.push(token.value);
    else if (clauseReads && !clauseWrites) sources.push(token.value);
  }
  const assigned = /* @__PURE__ */ new Set([...sources, ...outputs]);
  return { sources: unique(sources), outputs: unique(outputs), complete: assigned.size === unique(tokens.map((token) => token.value)).length };
}
function baseState(mode, reason, requiredReadTargets = [], requiredWriteTargets = [], enabled = true) {
  return {
    enabled,
    mode,
    reason,
    requiredReadTargets: unique(requiredReadTargets),
    requiredWriteTargets: unique(requiredWriteTargets),
    successfulReadTargets: [],
    successfulWriteTargets: [],
    successfulList: false,
    successfulSearch: false,
    failedOrDenied: false
  };
}
function disabled(reason) {
  return baseState("disabled", reason, [], [], false);
}
function categoryHas(category, value) {
  return category === value || category.includes(value);
}
function deriveCompletionPolicy(userInput, activeSelection, options = {}) {
  if (options.optimizationEnabled === false) return disabled("disabled-optimization");
  if (activeSelection.category === "explicit-run-scoped") return disabled("disabled-explicit-run-scoped");
  if (activeSelection.conservativeFallback || activeSelection.category === "uncertain" || activeSelection.category === "full") {
    return disabled("disabled-uncertain");
  }
  const text = normalize(userInput);
  const category = activeSelection.category;
  const hasCommand = categoryHas(category, "command") || COMMAND_PATTERN.test(text);
  if (hasCommand) return disabled("disabled-command");
  if (VERIFICATION_PATTERN.test(text)) return disabled("disabled-verification");
  const tokens = extractPathTokens(text);
  const targets = unique(tokens.map((token) => token.value));
  const hasList = LIST_PATTERN.test(text);
  const hasSearch = SEARCH_PATTERN.test(text);
  const hasContentRead = READ_CONTENT_PATTERN.test(text);
  const hasWrite = categoryHas(category, "write") || WRITE_PATTERN.test(text);
  const hasRead = hasContentRead || categoryHas(category, "read") && !hasList && !hasSearch;
  if (hasList && !hasSearch && !hasContentRead && !hasWrite) return baseState("pure-list", "list-complete");
  if (hasSearch && !hasList && !hasContentRead && !hasWrite) return baseState("pure-search", "search-complete");
  if ((hasList || hasSearch) && (hasContentRead || hasWrite)) return disabled("disabled-discovery-chain");
  if (hasList && hasSearch) return disabled("disabled-uncertain");
  if (hasRead && hasWrite) {
    const roles = classifyRoles(text, tokens);
    if (roles.complete && roles.sources.length === 1 && roles.outputs.length === 1 && !roles.sources.some((source) => roles.outputs.includes(source))) {
      return baseState("read-write", "read-write-complete", roles.sources, roles.outputs);
    }
    return disabled("disabled-ambiguous-target");
  }
  if (hasWrite) {
    if (targets.length === 1 && !tokens.some((token) => token.pattern)) return baseState("single-write", "single-write-complete", [], targets);
    if (targets.length >= 2 && !tokens.some((token) => token.pattern)) return baseState("multi-write", "disabled-multi-target", [], targets);
    if (targets.length === 0 && !MULTI_ACTION_PATTERN.test(text) && !hasRead && !hasList && !hasSearch) {
      return baseState("single-write", "single-write-complete");
    }
    return disabled("disabled-uncertain");
  }
  if (hasRead) {
    if (targets.length >= 2 || tokens.some((token) => token.pattern)) return baseState("multi-read", "disabled-multi-target", targets, []);
    if (targets.length === 1) return baseState("single-read", "single-read-complete", targets, []);
    return disabled("disabled-uncertain");
  }
  return disabled("disabled-unknown");
}
function bareToolName(name) {
  const normalized = normalize(name).trim();
  const marker = normalized.lastIndexOf("__");
  return marker >= 0 ? normalized.slice(marker + 2) : normalized.replace(/^host[.:]/u, "");
}
function explicitReadTargets(args) {
  if (typeof args.path === "string" && args.path.trim()) return [canonicalPath(args.path)];
  if (Array.isArray(args.paths)) return args.paths.filter((value) => typeof value === "string" && value.trim().length > 0).map(canonicalPath);
  return [];
}
function explicitWriteTargets(args) {
  return typeof args.path === "string" && args.path.trim() ? [canonicalPath(args.path)] : [];
}
function mergeState(state, patch) {
  return { ...state, ...patch };
}
function recordToolOutcome(state, toolName, args, status) {
  if (status !== "succeeded") return mergeState(state, { failedOrDenied: true });
  const bare = bareToolName(toolName);
  if (bare === "list_files") return mergeState(state, { successfulList: true });
  if (bare === "search_files") return mergeState(state, { successfulSearch: true });
  const safeArgs = args ?? {};
  if (bare === "read_file" || bare === "read_xlsx" || bare === "read_files") {
    return mergeState(state, { successfulReadTargets: unique([...state.successfulReadTargets, ...explicitReadTargets(safeArgs)]) });
  }
  if (bare === "write_file" || bare === "edit_file") {
    return mergeState(state, { successfulWriteTargets: unique([...state.successfulWriteTargets, ...explicitWriteTargets(safeArgs)]) });
  }
  return state;
}
function recordSuccessfulTool(state, toolName, args) {
  return recordToolOutcome(state, toolName, args, "succeeded");
}
function includesAll(have, required) {
  const set = new Set(have);
  return required.every((target) => set.has(target));
}
function shouldEnterToolsClosedFinal(state) {
  if (!state.enabled || state.failedOrDenied) return false;
  switch (state.mode) {
    case "single-read":
    case "multi-read":
      return includesAll(state.successfulReadTargets, state.requiredReadTargets);
    case "pure-list":
      return state.successfulList;
    case "pure-search":
      return state.successfulSearch;
    case "single-write":
      return state.requiredWriteTargets.length > 0 ? includesAll(state.successfulWriteTargets, state.requiredWriteTargets) : state.successfulWriteTargets.length === 1;
    case "multi-write":
      return includesAll(state.successfulWriteTargets, state.requiredWriteTargets);
    case "read-write":
      return includesAll(state.successfulReadTargets, state.requiredReadTargets) && includesAll(state.successfulWriteTargets, state.requiredWriteTargets);
    default:
      return false;
  }
}

// test/completion-policy.ts
function selection(category, conservativeFallback = false) {
  return { toolDefs: [], category, conservativeFallback, reason: "test selection" };
}
function policy(request, category = "read", conservativeFallback = false) {
  return deriveCompletionPolicy(request, selection(category, conservativeFallback));
}
function successful(state, tool, args) {
  return recordSuccessfulTool(state, tool, args);
}
function testSingleRead() {
  let state = policy("A.txt\u3092\u8AAD\u3093\u3067");
  import_strict.default.equal(state.mode, "single-read");
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false);
  state = successful(state, "read_file", { path: "A.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), true);
}
function testDiscoveryChainsStayOpen() {
  for (const request of ["\u4F5C\u696D\u30D5\u30A9\u30EB\u30C0\u304B\u3089\u8ACB\u6C42\u66F8\u3092\u63A2\u3057\u3066\u3001\u305D\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u8AAD\u3093\u3067\u5185\u5BB9\u3092\u6559\u3048\u3066", "\u4E00\u89A7\u3092\u78BA\u8A8D\u3057\u3066\u3001\u305D\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u8AAD\u3093\u3067", "\u30D5\u30A1\u30A4\u30EB\u3092\u63A2\u3057\u3066\u7D50\u679C\u3092output.txt\u3078\u66F8\u3044\u3066"]) {
    const state = policy(request);
    import_strict.default.equal(state.enabled, false);
    import_strict.default.equal(state.reason, "disabled-discovery-chain");
    const tool = request.includes("output.txt") ? "write_file" : request.includes("\u63A2") ? "search_files" : "list_files";
    import_strict.default.equal(shouldEnterToolsClosedFinal(recordSuccessfulTool(state, tool, {})), false);
  }
}
function testPureDiscoveryCanClose() {
  let list = policy("\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u4E00\u89A7\u3057\u3066\u304F\u3060\u3055\u3044");
  import_strict.default.equal(list.mode, "pure-list");
  list = successful(list, "list_files", {});
  import_strict.default.equal(shouldEnterToolsClosedFinal(list), true);
  let search = policy("\u30D5\u30A1\u30A4\u30EB\u5185\u5BB9\u3092\u691C\u7D22\u3057\u3066\u304F\u3060\u3055\u3044");
  import_strict.default.equal(search.mode, "pure-search");
  search = successful(search, "search_files", { query: "keyword" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(search), true);
}
function testMultipleReads() {
  let state = policy("A.txt\u3068B.txt\u3092\u8AAD\u3093\u3067\u6BD4\u8F03\u3057\u3066");
  import_strict.default.equal(state.mode, "multi-read");
  state = successful(state, "read_file", { path: "A.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false);
  state = successful(state, "read_file", { path: "B.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), true);
  let batch = policy("A.txt\u3068B.txt\u3092\u8AAD\u3093\u3067\u6BD4\u8F03\u3057\u3066");
  batch = successful(batch, "read_files", { paths: ["A.txt", "B.txt"] });
  import_strict.default.equal(shouldEnterToolsClosedFinal(batch), true);
  let pattern = policy("A.txt\u3068B.txt\u3092\u8AAD\u3093\u3067\u6BD4\u8F03\u3057\u3066");
  pattern = successful(pattern, "read_files", { pattern: "*.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(pattern), false);
}
function testMultipleWrites() {
  let state = policy("A.txt\u3068B.txt\u3092\u4F5C\u6210\u3057\u3066", "write");
  import_strict.default.equal(state.mode, "multi-write");
  state = successful(state, "write_file", { path: "A.txt", content: "a" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false);
  state = successful(state, "write_file", { path: "B.txt", content: "b" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), true);
}
function testReadWriteRequiresBothRoles() {
  let state = policy("source.txt\u3092\u8AAD\u3093\u3067\u3001\u7D50\u679C\u3092output.txt\u3078\u66F8\u3044\u3066", "read-write");
  import_strict.default.equal(state.mode, "read-write");
  state = successful(state, "read_file", { path: "source.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false);
  state = successful(state, "write_file", { path: "output.txt", content: "result" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), true);
  const ambiguous = policy("A.txt\u3092\u8AAD\u3093\u3067\u4FDD\u5B58\u3057\u3066", "read-write");
  import_strict.default.equal(ambiguous.enabled, false);
  import_strict.default.equal(ambiguous.reason, "disabled-ambiguous-target");
}
function testSingleWriteAndPathExtraction() {
  let state = policy("output.txt\u3092\u4F5C\u6210\u3057\u3066", "write");
  import_strict.default.equal(state.mode, "single-write");
  state = successful(state, "write_file", { path: "output.txt", content: "ok" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), true);
  import_strict.default.deepEqual(extractPathLikeTargets("../dir\\output.txt \u3068 data.json"), ["../dir/output.txt", "data.json"]);
  import_strict.default.deepEqual(extractPathLikeTargets("\u6982\u8981_\u65E5\u672C\u8A9E.txt\u3092\u8AAD\u3093\u3067\u3001\u8272\u3092\u6559\u3048\u3066\u304F\u3060\u3055\u3044\u3002"), ["\u6982\u8981_\u65E5\u672C\u8A9E.txt"]);
}
function testQ6ProfileContract() {
  const q6 = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.resolve(process.cwd(), "config.ollama.q6.json"), "utf8"));
  import_strict.default.equal(q6.agentLoop, "v2");
  import_strict.default.equal(q6.provider, "ollama");
  import_strict.default.equal(q6.model, "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q6_K");
  import_strict.default.equal(q6.agentOptimization, "on");
  import_strict.default.equal(q6.reasoningEffort, "none");
  import_strict.default.deepEqual(q6.generationLimits, {
    readToolRequestMaxOutputTokens: 128,
    actionToolRequestMaxOutputTokens: 1024,
    finalResponseMaxOutputTokens: 192
  });
  import_strict.default.equal(Object.hasOwn(q6, "num_ctx"), false);
  const q4 = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.resolve(process.cwd(), "config.ollama.json"), "utf8"));
  import_strict.default.equal(q4.model, "ornith-1.5:9b");
  import_strict.default.equal(q4.generationLimits.readToolRequestMaxOutputTokens, 256);
}
function testFailClosedKindsAndFailures() {
  for (const [request, category] of [
    ["\u30B3\u30DE\u30F3\u30C9\u3092\u5B9F\u884C\u3057\u3066", "command"],
    ["\u5B9F\u88C5\u3057\u3066\u304F\u3060\u3055\u3044", "write"],
    ["\u305D\u308C\u3092\u51E6\u7406\u3057\u3066", "uncertain"]
  ]) {
    const state2 = policy(request, category);
    import_strict.default.equal(state2.enabled, false);
    import_strict.default.equal(shouldEnterToolsClosedFinal(successful(state2, "read_file", { path: "A.txt" })), false);
  }
  let state = policy("A.txt\u3092\u8AAD\u3093\u3067");
  state = recordToolOutcome(state, "read_file", { path: "A.txt" }, "failed");
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false);
  state = successful(state, "read_file", { path: "A.txt" });
  import_strict.default.equal(shouldEnterToolsClosedFinal(state), false, "a later success must not erase a failure");
}
function testOptimizationOffAndUncertain() {
  import_strict.default.equal(deriveCompletionPolicy("A.txt\u3092\u8AAD\u3093\u3067", selection("read"), { optimizationEnabled: false }).enabled, false);
  import_strict.default.equal(policy("A.txt\u3092\u8AAD\u3093\u3067", "read", true).enabled, false);
  import_strict.default.equal(policy("A.txt\u3092\u8AAD\u3093\u3067", "explicit-run-scoped").enabled, false);
}
testSingleRead();
testDiscoveryChainsStayOpen();
testPureDiscoveryCanClose();
testMultipleReads();
testMultipleWrites();
testReadWriteRequiresBothRoles();
testSingleWriteAndPathExtraction();
testQ6ProfileContract();
testFailClosedKindsAndFailures();
testOptimizationOffAndUncertain();
console.log("PASS completion-policy");
