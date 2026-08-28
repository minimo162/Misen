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

// test/active-tools.ts
var import_strict = __toESM(require("node:assert/strict"));

// src/active-tools.ts
var READ_SIGNAL_PATTERNS = [
  /\bread\b/u,
  /\blist\b/u,
  /\bsearch\b/u,
  /\bfind\b/u,
  /\blook\s*up\b/u,
  /\blookup\b/u,
  /\binspect\b/u,
  /\bexamine\b/u,
  /\bshow\b/u,
  /\bview\b/u,
  /\bopen\b/u,
  /\bcheck\b/u,
  /\bscan\b/u,
  /\bget\b/u,
  /\bweather\b/u,
  /読む/u,
  /読み/u,
  /読んで/u,
  /一覧/u,
  /列挙/u,
  /検索/u,
  /探(?:す|して|したい)/u,
  /調べ/u,
  /確認/u,
  /表示/u,
  /閲覧/u,
  /開(?:く|いて|けて)/u,
  /見(?:る|せて|たい)/u,
  /天気/u
];
var WRITE_SIGNAL_PATTERNS = [
  /\bwrite\b/u,
  /\bcreate\b/u,
  /\bmake\b/u,
  /\bedit\b/u,
  /\bupdate\b/u,
  /\bmodify\b/u,
  /\bsave\b/u,
  /\bdelete\b/u,
  /\bremove\b/u,
  /\bappend\b/u,
  /\badd\b/u,
  /\bgenerate\b/u,
  /\bimplement\b/u,
  /\bfix\b/u,
  /\bpatch\b/u,
  /\brefactor\b/u,
  /\bbuild\b/u,
  /\bartifact\b/u,
  /\breport\b/u,
  /\bdraft\b/u,
  /\boverwrite\b/u,
  /\brename\b/u,
  /書(?:く|き|いて|け)/u,
  /作(?:成|る|って|りたい)/u,
  /生成/u,
  /編集/u,
  /更新/u,
  /修正/u,
  /変更/u,
  /保存/u,
  /削除/u,
  /追加/u,
  /実装/u,
  /直して/u
];
var COMMAND_SIGNAL_PATTERNS = [
  /\bopen\b/u,
  /\brun\b/u,
  /\bexecute\b/u,
  /\bexec\b/u,
  /\bcommand\b/u,
  /\bshell\b/u,
  /\bterminal\b/u,
  /\bprocess\b/u,
  /\bstart\b/u,
  /\bstop\b/u,
  /\bkill\b/u,
  /\blaunch\b/u,
  /\bspawn\b/u,
  /\bnetwork\b/u,
  /\bfetch\b/u,
  /\bdownload\b/u,
  /\binstall\b/u,
  /\bfix\b/u,
  /\bimplement\b/u,
  /\brefactor\b/u,
  /\bbuild\b/u,
  /\bcurl\b/u,
  /\bwget\b/u,
  /\bnpm\b/u,
  /\bpnpm\b/u,
  /\byarn\b/u,
  /\bbun\b/u,
  /\bgit\b/u,
  /\bhttps?\b/u,
  /\burl\b/u,
  /実行/u,
  /コマンド/u,
  /シェル/u,
  /ターミナル/u,
  /プロセス/u,
  /起動/u,
  /停止/u,
  /終了/u,
  /ネットワーク/u,
  /接続/u,
  /ダウンロード/u,
  /インストール/u,
  /実装/u,
  /バグ(?:を)?修正/u,
  /リファクタ/u,
  /ビルド/u,
  /外部(?:サイト|URL|サービス)/u,
  /ウェブ/u,
  /ブラウザ/u,
  /開(?:く|いて|けて)/u,
  /curl/u,
  /天気(?:を)?(?:取得|確認)/u
];
var NETWORK_SIGNAL_PATTERNS = [
  /\bnetwork\b/u,
  /\bfetch\b/u,
  /\bdownload\b/u,
  /\bhttps?\b/u,
  /\burl\b/u,
  /\bweb(?:site)?\b/u,
  /\bbrowser\b/u,
  /\bweather\b/u,
  /\bget\s+weather\b/u,
  /ネットワーク/u,
  /接続/u,
  /ダウンロード/u,
  /外部(?:サイト|URL|サービス)/u,
  /ウェブ/u,
  /ブラウザ/u,
  /URL/u,
  /天気/u
];
var RESPONSE_ONLY_PATTERNS = [
  /(?:教えて|答えて|回答して|報告して|説明して|要約して|短くまとめて|日本語で返して|結果だけ知らせて)ください/u,
  /\btell\s+me\b/u,
  /\banswer\s+briefly\b/u,
  /\breport\s+the\s+result\b/u,
  /\bsummarize\s+it\b/u,
  /\bexplain\s+the\s+result\b/u,
  /\brespond\s+in\s+japanese\b/u
];
var RESPONSE_PATH_PATTERN = /(?:^|[\s"'`([{、。！？])(?:\.{0,2}[\\/])?[^\s"'`()[\],;:！？。]*\.(?:txt|json|csv|md|xlsx|xlsm|pdf|html|js|ts|tsx|jsx|ps1|cmd|bat|yaml|yml|xml|toml|log|xls)(?=$|[\s"'`)、。！？,;:をのがはへにでとやも])/iu;
var RESPONSE_URL_PATTERN = /(?:https?:\/\/|www\.)/iu;
var RESPONSE_DESTINATION_PATTERN = /(?:\b(?:to|into|onto|save\s+to|write\s+to|report\s+to)\b|へ(?:保存|出力|反映|報告)?|に(?:保存|出力|反映|報告)?)/iu;
var NETWORK_TOOL_NAME_PATTERN = /(?:^|[_-])(?:fetch|request|http|https|url|web|browser|browse|download|network|weather)(?:$|[_-])/u;
var NETWORK_TOOL_DESCRIPTION_PATTERN = /(?:\b(?:https?|url|network|external|download|weather|open[- ]?meteo)\b|ネットワーク|外部(?:サイト|URL|サービス)|ダウンロード|天気)/u;
function normalize(value) {
  return value.normalize("NFKC").toLowerCase();
}
function hasAnySignal(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
function stripResponseOnlyDirectives(text) {
  return RESPONSE_ONLY_PATTERNS.reduce((remaining, pattern) => remaining.replace(pattern, " "), text);
}
function isResponseOnlyClause(clause) {
  const intent = classifyIntent(clause);
  if (intent.read || intent.write || intent.command || intent.network) return false;
  if (RESPONSE_PATH_PATTERN.test(clause) || RESPONSE_URL_PATTERN.test(clause) || /[\\/]/u.test(clause)) return false;
  if (RESPONSE_DESTINATION_PATTERN.test(clause)) return false;
  return hasAnySignal(clause, RESPONSE_ONLY_PATTERNS);
}
function classifyIntent(userInput) {
  const text = normalize(userInput);
  const hostText = stripResponseOnlyDirectives(text);
  return {
    read: hasAnySignal(hostText, READ_SIGNAL_PATTERNS),
    write: hasAnySignal(hostText, WRITE_SIGNAL_PATTERNS),
    command: hasAnySignal(hostText, COMMAND_SIGNAL_PATTERNS),
    network: hasAnySignal(hostText, NETWORK_SIGNAL_PATTERNS)
  };
}
var CLAUSE_SEPARATOR = /(?:\b(?:and|then|also|but|plus|afterwards?|followed\s+by)\b|[,&;|]+|\r?\n|、|。|(?:してから|した後|その後|さらに|また|および|及び|ならびに|かつ))/u;
function hasUnrecognizedMixedClause(request, toolDefs) {
  const clauses = normalize(request).split(CLAUSE_SEPARATOR).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length < 2) return false;
  return clauses.some((clause) => {
    const intent = inferIntentFromToolNames(clause, toolDefs, classifyIntent(clause));
    if (intent.read || intent.write || intent.command || intent.network) return false;
    return !isResponseOnlyClause(clause);
  });
}
function inferIntentFromToolNames(request, toolDefs, intent) {
  const inferred = { ...intent };
  for (const def of toolDefs) {
    if (!toolNameMentioned(request, def.name)) continue;
    if (def.kind === "read") inferred.read = true;
    if (def.kind === "write") inferred.write = true;
    if (def.kind === "command") inferred.command = true;
    if (isNetworkTool(def)) inferred.network = true;
  }
  return inferred;
}
function normalizeToolName(value) {
  const normalized = normalize(value).trim();
  return normalized.startsWith("host__") ? normalized.slice("host__".length) : normalized;
}
function toolNameMentioned(request, toolName) {
  const normalizedName = normalizeToolName(toolName);
  if (!normalizedName) return false;
  if (request.includes(normalizedName)) return true;
  const spacedName = normalizedName.replace(/[_-]+/gu, " ").trim();
  return spacedName.length > 0 && request.includes(spacedName);
}
function isNetworkTool(def) {
  const name = normalizeToolName(def.name);
  const description = normalize(def.description);
  return NETWORK_TOOL_NAME_PATTERN.test(name) || NETWORK_TOOL_DESCRIPTION_PATTERN.test(description);
}
function networkToolRelevant(def, request, intent) {
  const named = toolNameMentioned(request, def.name);
  if (named) return true;
  if (!intent.network) return false;
  if (/weather|天気/u.test(request)) {
    const toolText = `${normalizeToolName(def.name)} ${normalize(def.description)}`;
    return /weather|open[- ]?meteo|天気/u.test(toolText);
  }
  return true;
}
function categoryForIntent(intent) {
  if (intent.read && intent.write && intent.command) return "read-write-command";
  if (intent.read && intent.write) return "read-write";
  if (intent.read && intent.command) return "read-command";
  if (intent.write && intent.command) return "write-command";
  if (intent.read) return "read";
  if (intent.write) return "write";
  return "command";
}
function selectByIntent(toolDefs, request, intent) {
  return toolDefs.filter((def) => {
    if (def.kind === "read") {
      if (!intent.read && !intent.write && !intent.command) return false;
      if (isNetworkTool(def) && !networkToolRelevant(def, request, intent)) return false;
      return true;
    }
    if (def.kind === "write") return intent.write;
    if (def.kind === "command") return intent.command;
    return false;
  });
}
function allSelection(toolDefs, category, conservativeFallback, reason) {
  return { toolDefs, category, conservativeFallback, reason };
}
function selectActiveTools(first, second, third) {
  const options = "toolDefs" in first ? first : { ...third ?? {}, toolDefs: first, userInput: second ?? "" };
  const toolDefs = Array.isArray(options.toolDefs) ? options.toolDefs : [];
  const request = typeof options.userInput === "string" ? normalize(options.userInput) : "";
  if (options.explicitRunScoped === true) {
    return allSelection(toolDefs, "explicit-run-scoped", false, "explicit run-scoped tool definitions preserved");
  }
  if (options.optimizationEnabled === false) {
    return allSelection(toolDefs, "full", false, "active-tools optimization disabled; all supplied policy-filtered tools retained");
  }
  if (options.mode !== void 0 && options.mode !== "work") {
    return allSelection(toolDefs, "full", false, "active-tools applies only to work turns; all supplied policy-filtered tools retained");
  }
  if (/^(?:open|開く|開いて|開けて)$/u.test(request.trim())) {
    return allSelection(toolDefs, "uncertain", true, "bare open intent is ambiguous; all supplied policy-filtered tools retained conservatively");
  }
  if (hasUnrecognizedMixedClause(request, toolDefs)) {
    return allSelection(toolDefs, "uncertain", true, "a mixed request contains an unrecognized clause; all supplied policy-filtered tools retained conservatively");
  }
  const intent = inferIntentFromToolNames(request, toolDefs, classifyIntent(request));
  if (!intent.read && !intent.write && !intent.command) {
    return allSelection(toolDefs, "uncertain", true, "intent was not recognized; all supplied policy-filtered tools retained conservatively");
  }
  const selected = selectByIntent(toolDefs, request, intent);
  const category = categoryForIntent(intent);
  const suffix = intent.network ? "network indication present" : "command/process/network tools withheld unless indicated";
  return {
    toolDefs: selected,
    category,
    conservativeFallback: false,
    reason: `${category} intent; ${suffix}`
  };
}
function sourceToolDefs(source) {
  if (!("toolDefs" in source)) return source;
  const selection = source;
  return Array.isArray(selection.toolDefs) ? selection.toolDefs : [];
}
function sameToolName(left, right) {
  const a = normalizeToolName(left);
  const b = normalizeToolName(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`__${b}`) || b.endsWith(`__${a}`);
}
function isToolSelected(first, second) {
  const requested = typeof first === "string" ? first : second;
  const source = typeof first === "string" ? second : first;
  if (typeof requested !== "string" || !requested.trim()) return false;
  return sourceToolDefs(source).some((def) => sameToolName(def.name, requested));
}
function detectMissingActiveTool(first, second) {
  const requestedToolName = typeof first === "string" ? first : second;
  const source = typeof first === "string" ? second : first;
  const selected = isToolSelected(source, requestedToolName);
  const normalizedName = typeof requestedToolName === "string" ? requestedToolName.trim() : "";
  return {
    requestedToolName: normalizedName,
    selected,
    missing: !selected,
    conservativeRetryRecommended: !selected,
    reason: selected ? "requested tool is present in the active set" : "requested tool is absent; caller must choose a conservative retry or abort"
  };
}
var checkActiveTool = detectMissingActiveTool;

// test/active-tools.ts
function fakeTool(name, kind, description = name) {
  return {
    name,
    description,
    kind,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return "";
    }
  };
}
var tools = [
  fakeTool("list_files", "read", "list workspace files"),
  fakeTool("read_file", "read", "read one local file"),
  fakeTool("search_files", "read", "search local files"),
  fakeTool("get_weather", "read", "fetch current weather from Open-Meteo"),
  fakeTool("fetch_url", "read", "fetch an HTTP URL"),
  fakeTool("write_file", "write", "create or overwrite a local file"),
  fakeTool("edit_file", "write", "edit a local file"),
  fakeTool("start_process", "command", "start a process"),
  fakeTool("run_command", "command", "run a shell command")
];
function names(selection) {
  return selection.toolDefs.map((tool) => tool.name);
}
function testReadAndOpenRequests() {
  const listed = selectActiveTools({ toolDefs: tools, userInput: "Please list and inspect the files" });
  import_strict.default.equal(listed.category, "read");
  import_strict.default.equal(listed.conservativeFallback, false);
  import_strict.default.deepEqual(names(listed), ["list_files", "read_file", "search_files"]);
  import_strict.default.ok(!names(listed).includes("write_file"));
  import_strict.default.ok(!names(listed).includes("run_command"));
  const opened = selectActiveTools({ toolDefs: tools, userInput: "Open the README file" });
  import_strict.default.equal(opened.category, "read-command");
  import_strict.default.ok(names(opened).includes("read_file"));
  import_strict.default.ok(names(opened).includes("start_process"), "explicit open intent must retain the normal safe-open path");
  const Japanese = selectActiveTools({ toolDefs: tools, userInput: "\u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22\u3057\u3066\u4E00\u89A7\u3092\u8868\u793A\u3057\u3066" });
  import_strict.default.equal(Japanese.category, "read");
  import_strict.default.deepEqual(names(Japanese), ["list_files", "read_file", "search_files"]);
}
function testWriteRequestsExposeReadAndWrite() {
  const created = selectActiveTools({ toolDefs: tools, userInput: "Create a report artifact" });
  import_strict.default.equal(created.category, "write");
  import_strict.default.deepEqual(names(created), ["list_files", "read_file", "search_files", "write_file", "edit_file"]);
  import_strict.default.ok(!names(created).includes("run_command"));
  const investigated = selectActiveTools({ toolDefs: tools, userInput: "Read the existing report, then update it" });
  import_strict.default.equal(investigated.category, "read-write");
  import_strict.default.deepEqual(names(investigated), ["list_files", "read_file", "search_files", "write_file", "edit_file"]);
}
function testCommandAndNetworkSignals() {
  const command = selectActiveTools({ toolDefs: tools, userInput: "Run the tests from the terminal" });
  import_strict.default.equal(command.category, "command");
  import_strict.default.ok(names(command).includes("run_command"));
  import_strict.default.ok(names(command).includes("start_process"));
  import_strict.default.ok(names(command).includes("read_file"), "command turns retain local reads for setup/inspection");
  import_strict.default.ok(!names(command).includes("write_file"));
  import_strict.default.ok(!names(command).includes("fetch_url"), "network read tools stay hidden without network indication");
  const network = selectActiveTools({ toolDefs: tools, userInput: "Fetch the URL with curl" });
  import_strict.default.equal(network.category, "command");
  import_strict.default.ok(names(network).includes("fetch_url"));
  import_strict.default.ok(names(network).includes("run_command"));
  const namedCommand = selectActiveTools({ toolDefs: tools, userInput: "Please call run_command" });
  import_strict.default.equal(namedCommand.category, "command", "an explicit generic tool name is a command indication");
  import_strict.default.ok(names(namedCommand).includes("run_command"));
  import_strict.default.ok(!names(namedCommand).includes("write_file"));
  const weather = selectActiveTools({ toolDefs: tools, userInput: "Check the weather" });
  import_strict.default.equal(weather.category, "read");
  import_strict.default.ok(names(weather).includes("get_weather"));
  import_strict.default.ok(!names(weather).includes("fetch_url"));
  for (const codingRequest of ["Fix the bug", "Implement the feature", "Refactor this module", "\u30A2\u30D7\u30EA\u3092\u5B9F\u88C5\u3057\u3066\u304F\u3060\u3055\u3044"]) {
    const coding = selectActiveTools({ toolDefs: tools, userInput: codingRequest });
    import_strict.default.ok(coding.category.includes("write"));
    import_strict.default.ok(coding.category.includes("command"));
    import_strict.default.ok(names(coding).includes("write_file"));
    import_strict.default.ok(names(coding).includes("run_command"), `${codingRequest} must retain verification commands`);
  }
}
function testUncertainAndPolicyInput() {
  const uncertain = selectActiveTools({ toolDefs: tools, userInput: "Help me with this" });
  import_strict.default.equal(uncertain.category, "uncertain");
  import_strict.default.equal(uncertain.conservativeFallback, true);
  import_strict.default.strictEqual(uncertain.toolDefs, tools, "uncertain requests retain the exact policy-filtered input");
  const policyFiltered = tools.filter((tool) => tool.name !== "run_command");
  const widened = selectActiveTools({ toolDefs: policyFiltered, userInput: "No recognizable intent here: fixture_abc task_123" });
  import_strict.default.equal(widened.conservativeFallback, true);
  import_strict.default.strictEqual(widened.toolDefs, policyFiltered);
  import_strict.default.ok(!names(widened).includes("run_command"), "selector must not reintroduce policy-disabled tools");
  const bareOpen = selectActiveTools({ toolDefs: tools, userInput: "\u958B\u304F" });
  import_strict.default.equal(bareOpen.conservativeFallback, true);
  import_strict.default.strictEqual(bareOpen.toolDefs, tools);
  const mixedUnknown = selectActiveTools({ toolDefs: tools, userInput: "Read README and copy it to backup.txt" });
  import_strict.default.equal(mixedUnknown.category, "uncertain");
  import_strict.default.equal(mixedUnknown.conservativeFallback, true);
  import_strict.default.strictEqual(mixedUnknown.toolDefs, tools, "an unknown additional clause must widen instead of hiding a needed tool");
  for (const request of ["Read README & copy it to backup.txt", "Read README\ncopy it to backup.txt", "README\u3092\u8AAD\u3093\u3067\u3001\u304A\u3088\u3073\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u306B\u3082\u53CD\u6620"]) {
    const separated = selectActiveTools({ toolDefs: tools, userInput: request });
    import_strict.default.equal(separated.conservativeFallback, true, `${request} must preserve the policy-filtered fallback`);
    import_strict.default.strictEqual(separated.toolDefs, tools);
  }
  const disabled = selectActiveTools({ toolDefs: tools, userInput: "Help me with this", optimizationEnabled: false });
  import_strict.default.equal(disabled.category, "full");
  import_strict.default.equal(disabled.conservativeFallback, false);
  import_strict.default.strictEqual(disabled.toolDefs, tools);
  const nonWork = selectActiveTools({ toolDefs: tools, userInput: "List files", mode: "ask" });
  import_strict.default.equal(nonWork.category, "full");
  import_strict.default.strictEqual(nonWork.toolDefs, tools);
}
function testResponseOnlyClauses() {
  const japanese = selectActiveTools({ toolDefs: tools, userInput: "\u6982\u8981_\u65E5\u672C\u8A9E.txt\u3092\u8AAD\u3093\u3067\u3001\u8272\u3092\u6559\u3048\u3066\u304F\u3060\u3055\u3044\u3002" });
  import_strict.default.equal(japanese.category, "read");
  import_strict.default.equal(japanese.conservativeFallback, false);
  import_strict.default.deepEqual(names(japanese), ["list_files", "read_file", "search_files"]);
  const english = selectActiveTools({ toolDefs: tools, userInput: "Read README and tell me the color." });
  import_strict.default.equal(english.category, "read");
  import_strict.default.equal(english.conservativeFallback, false);
  import_strict.default.deepEqual(names(english), ["list_files", "read_file", "search_files"]);
  const unknownAction = selectActiveTools({ toolDefs: tools, userInput: "Read README and perform an unknown operation." });
  import_strict.default.equal(unknownAction.category, "uncertain");
  import_strict.default.equal(unknownAction.conservativeFallback, true);
  import_strict.default.strictEqual(unknownAction.toolDefs, tools);
  const mixedAction = selectActiveTools({ toolDefs: tools, userInput: "Read README, tell me the result, then update it." });
  import_strict.default.equal(mixedAction.category, "read-write");
  import_strict.default.equal(mixedAction.conservativeFallback, false);
  import_strict.default.deepEqual(names(mixedAction), ["list_files", "read_file", "search_files", "write_file", "edit_file"]);
  for (const request of [
    "Read README and report the result to output.txt.",
    "README\u3092\u8AAD\u3093\u3067\u3001\u7D50\u679C\u3092output.txt\u306B\u5831\u544A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    "README\u3092\u8AAD\u3093\u3067\u3001\u7D50\u679C\u3092\u5171\u6709\u30D5\u30A9\u30EB\u30C0\u3078\u5831\u544A\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
  ]) {
    const guarded = selectActiveTools({ toolDefs: tools, userInput: request });
    import_strict.default.equal(guarded.conservativeFallback, true, `${request} must retain the conservative fallback`);
    import_strict.default.strictEqual(guarded.toolDefs, tools);
  }
  const unknownDestination = selectActiveTools({ toolDefs: tools, userInput: "\u7D50\u679C\u3092/to/output.txt\u3078\u8EE2\u9001\u3057\u3066\u304F\u3060\u3055\u3044" });
  import_strict.default.equal(unknownDestination.conservativeFallback, true);
  import_strict.default.strictEqual(unknownDestination.toolDefs, tools);
}
function testExplicitRunScopedAndMissingToolFailSafe() {
  const scoped = [tools[0], tools[7]];
  const explicit = selectActiveTools({
    toolDefs: scoped,
    userInput: "Delete everything and run a shell command",
    explicitRunScoped: true
  });
  import_strict.default.equal(explicit.category, "explicit-run-scoped");
  import_strict.default.equal(explicit.conservativeFallback, false);
  import_strict.default.strictEqual(explicit.toolDefs, scoped, "explicit run-scoped defs must be preserved verbatim");
  import_strict.default.deepEqual(names(explicit), ["list_files", "start_process"]);
  import_strict.default.equal(isToolSelected(explicit, "start_process"), true);
  import_strict.default.equal(isToolSelected("host__start_process", explicit), true);
  import_strict.default.equal(isToolSelected(explicit, "run_command"), false);
  const missing = detectMissingActiveTool(explicit, "run_command");
  import_strict.default.equal(missing.selected, false);
  import_strict.default.equal(missing.missing, true);
  import_strict.default.equal(missing.conservativeRetryRecommended, true);
  import_strict.default.match(missing.reason, /retry|abort/u);
  import_strict.default.strictEqual(explicit.toolDefs, scoped, "missing-tool inspection must not widen or mutate the set");
  const present = checkActiveTool("start_process", explicit);
  import_strict.default.equal(present.selected, true);
  import_strict.default.equal(present.missing, false);
  import_strict.default.equal(present.conservativeRetryRecommended, false);
}
function testExplicitToolNameIsNeverDropped() {
  const namedWrite = selectActiveTools({ toolDefs: tools, userInput: "Use write_file with the supplied path" });
  import_strict.default.equal(namedWrite.category, "write");
  import_strict.default.ok(names(namedWrite).includes("write_file"));
  import_strict.default.ok(!names(namedWrite).includes("run_command"));
  const namedCommand = selectActiveTools({ toolDefs: tools, userInput: "Please use run_command" });
  import_strict.default.equal(namedCommand.category, "command");
  import_strict.default.ok(names(namedCommand).includes("run_command"));
}
function main() {
  testReadAndOpenRequests();
  testWriteRequestsExposeReadAndWrite();
  testCommandAndNetworkSignals();
  testUncertainAndPolicyInput();
  testResponseOnlyClauses();
  testExplicitRunScopedAndMissingToolFailSafe();
  testExplicitToolNameIsNeverDropped();
  console.log("PASS active-tools");
}
main();
