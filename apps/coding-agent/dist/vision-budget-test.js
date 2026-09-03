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

// test/vision-budget.ts
var import_strict = __toESM(require("node:assert/strict"));

// src/vision-budget.ts
var VISION_TOKEN_BUDGETS = [512, 768, 1024];
var DEFAULT_VISION_TOKEN_BUDGET = 512;
var DEFAULT_MAX_CONTEXT_TOKENS = 4096;
var DEFAULT_RESERVED_VISUAL_TOKENS = DEFAULT_VISION_TOKEN_BUDGET;
var QWEN_VISION_FACTOR = 32;
function normalizeVisionTokenBudget(requested) {
  const value = requested ?? DEFAULT_VISION_TOKEN_BUDGET;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("maxVisualTokens must be a positive finite number");
  const tier = VISION_TOKEN_BUDGETS.find((candidate) => candidate >= value);
  if (tier === void 0) throw new RangeError("maxVisualTokens exceeds the supported 4K budget (1024)");
  return tier;
}
function assertDimension(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
}
function estimateQwenVisualTokens(width, height, factor = QWEN_VISION_FACTOR) {
  assertDimension(width, "width");
  assertDimension(height, "height");
  if (!Number.isSafeInteger(factor) || factor <= 0) throw new RangeError("visual token factor must be a positive safe integer");
  const estimate = Math.ceil(width / factor) * Math.ceil(height / factor);
  if (!Number.isSafeInteger(estimate)) throw new RangeError("visual token estimate exceeds safe integer range");
  return estimate;
}
function requestParts(inputOrWidth, height, requested) {
  if (typeof inputOrWidth === "number") {
    if (height === void 0) throw new TypeError("height is required when width is passed positionally");
    return { width: inputOrWidth, height, requested: requested ?? DEFAULT_VISION_TOKEN_BUDGET };
  }
  return {
    width: inputOrWidth.width,
    height: inputOrWidth.height,
    requested: inputOrWidth.maxVisualTokens ?? inputOrWidth.requestedMaxVisualTokens ?? DEFAULT_VISION_TOKEN_BUDGET
  };
}
function selectVisionBudget(inputOrWidth, height, requested) {
  const input = requestParts(inputOrWidth, height, requested);
  assertDimension(input.width, "width");
  assertDimension(input.height, "height");
  const maxVisualTokens = normalizeVisionTokenBudget(input.requested);
  const factor = QWEN_VISION_FACTOR;
  const originalArea = input.width * input.height;
  if (!Number.isSafeInteger(originalArea) || originalArea <= 0) throw new RangeError("image dimensions exceed safe arithmetic range");
  const maxPixels = maxVisualTokens * factor * factor;
  const scale = Math.min(1, Math.sqrt(maxPixels / originalArea));
  let gridWidth = Math.max(1, Math.floor(input.width * scale / factor));
  let gridHeight = Math.max(1, Math.floor(input.height * scale / factor));
  while (gridWidth * gridHeight > maxVisualTokens) {
    if (gridWidth >= gridHeight && gridWidth > 1) gridWidth--;
    else if (gridHeight > 1) gridHeight--;
    else throw new RangeError("image cannot fit the requested visual-token budget");
  }
  const width = gridWidth * factor;
  const resizedHeight = gridHeight * factor;
  const estimatedVisualTokens = gridWidth * gridHeight;
  return {
    originalWidth: input.width,
    originalHeight: input.height,
    width,
    height: resizedHeight,
    resizedWidth: width,
    resizedHeight,
    maxVisualTokens,
    requestedMaxVisualTokens: input.requested,
    estimatedVisualTokens,
    estimatedTokens: estimatedVisualTokens,
    visualTokenFactor: factor,
    estimationBasis: "qwen-factor-32-grid-estimate",
    processorReported: false,
    resized: width !== input.width || resizedHeight !== input.height,
    dimensionsAlignedTo: factor,
    withinBudget: estimatedVisualTokens <= maxVisualTokens
  };
}
var MINIMAL_ACTIVE_TOOL_ALLOWLIST = ["open_company"];
function activeToolAllowlist(tools, allowedNames = MINIMAL_ACTIVE_TOOL_ALLOWLIST) {
  const allowed = new Set(allowedNames.filter((name) => typeof name === "string" && name.length > 0));
  return tools.filter((tool) => allowed.has(typeof tool === "string" ? tool : tool.name));
}
var DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]*/giu;
function scalar(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string" && value.length <= 256 && !/^data:image\//iu.test(value)) return value;
  return void 0;
}
function safeMetadata(message) {
  const output = {};
  const source = message.metadata;
  const raw = message;
  for (const key of ["tool", "status", "approval", "approved", "precondition", "before_sha256", "after_sha256", "path", "structuredObservation", "relevant"]) {
    const value = scalar(raw[key] ?? source?.[key]);
    if (value !== void 0) output[key] = value;
  }
  return output;
}
function textOnly(content) {
  if (typeof content === "string") {
    const images2 = content.match(DATA_IMAGE_RE)?.length ?? 0;
    return { text: content.replace(DATA_IMAGE_RE, "[image omitted]"), images: images2 };
  }
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const text = [];
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part;
    if (candidate.type === "image") {
      images++;
      continue;
    }
    if (candidate.type === "text" && typeof candidate.text === "string") text.push(candidate.text);
  }
  return { text: text.join(""), images };
}
function kindOf(message) {
  return `${typeof message.kind === "string" ? message.kind : ""} ${typeof message.type === "string" ? message.type : ""}`.toLowerCase();
}
function classify(message) {
  const metadata = safeMetadata(message);
  const kind = kindOf(message);
  const approval = metadata.approval !== void 0 || metadata.approved !== void 0 || /approval|permission/u.test(kind);
  const precondition = metadata.precondition !== void 0 || metadata.before_sha256 !== void 0 || metadata.after_sha256 !== void 0 || /precondition|before[_-]?sha|after[_-]?sha/u.test(kind);
  const structured = metadata.structuredObservation === true || /observation|finding|snapshot/u.test(kind);
  if (structured) metadata.structuredObservation = true;
  return { metadata, approval, precondition, structured };
}
function safeToolCalls(message) {
  if (!Array.isArray(message.tool_calls)) return void 0;
  const calls = [];
  for (const value of message.tool_calls) {
    if (!value || typeof value !== "object") continue;
    const call = value;
    const id = typeof call.id === "string" ? call.id.slice(0, 80) : "";
    const name = typeof call.function?.name === "string" ? call.function.name.slice(0, 120) : "";
    if (id || name) calls.push({ id, name });
  }
  return calls.length > 0 ? calls : void 0;
}
function toSafeMessage(candidate, content) {
  const toolCalls = safeToolCalls(candidate.message);
  return {
    role: candidate.message.role ?? "assistant",
    content,
    ...typeof candidate.message.name === "string" ? { name: candidate.message.name.slice(0, 120) } : {},
    ...typeof candidate.message.tool_call_id === "string" ? { tool_call_id: candidate.message.tool_call_id.slice(0, 120) } : {},
    ...toolCalls ? { tool_calls: toolCalls } : {},
    ...Object.keys(candidate.metadata).length > 0 ? { metadata: { ...candidate.metadata } } : {}
  };
}
function messageTokens(message) {
  return Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
}
function truncate(text, chars) {
  if (text.length <= chars) return text;
  if (chars <= 1) return text.slice(0, chars);
  const head = Math.ceil(chars * 0.7);
  return `${text.slice(0, head)}\u2026${text.slice(-(chars - head - 1))}`;
}
function positiveInteger(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${label} must be an integer between 0 and ${max}`);
}
function pruneWorkingContext(messages, options = {}) {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  if (!Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0 || maxContextTokens > DEFAULT_MAX_CONTEXT_TOKENS) throw new RangeError("maxContextTokens must be an integer between 1 and 4096");
  const reservedVisualTokens = options.reservedVisualTokens ?? DEFAULT_RESERVED_VISUAL_TOKENS;
  if (reservedVisualTokens > VISION_TOKEN_BUDGETS.at(-1)) throw new RangeError("reservedVisualTokens exceeds the supported 4K visual tier");
  positiveInteger(reservedVisualTokens, "reservedVisualTokens", VISION_TOKEN_BUDGETS.at(-1));
  if (reservedVisualTokens > maxContextTokens) throw new RangeError("reservedVisualTokens cannot exceed maxContextTokens");
  const availableTextTokens = maxContextTokens - reservedVisualTokens;
  const maxTextTokens = options.maxTextTokens ?? availableTextTokens;
  positiveInteger(maxTextTokens, "maxTextTokens", availableTextTokens);
  const maxToolResultChars = options.maxToolResultChars ?? 1600;
  const maxMessageChars = options.maxMessageChars ?? 4e3;
  const keepRecentMessages = options.keepRecentMessages ?? 6;
  positiveInteger(maxToolResultChars, "maxToolResultChars", 1e5);
  positiveInteger(maxMessageChars, "maxMessageChars", 1e5);
  positiveInteger(keepRecentMessages, "keepRecentMessages", 1e3);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const candidates = [];
  let reasoningDropped = 0;
  let imageCount = options.ephemeralContent && Array.isArray(options.ephemeralContent) ? options.ephemeralContent.filter((part) => part.type === "image").length : 0;
  let largeToolResults = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const kind = kindOf(message);
    const extracted = textOnly(message.content);
    imageCount += extracted.images;
    const reasoning = /reasoning|analysis|thought|<think>/u.test(kind) || message.role === "assistant" && /<think>|<analysis>/iu.test(extracted.text);
    if (reasoning) {
      reasoningDropped++;
      continue;
    }
    const classified = classify(message);
    const tool = message.role === "tool" || typeof message.tool_call_id === "string" || Array.isArray(message.tool_calls);
    const latestUser = index === latestUserIndex && message.role === "user";
    const required = latestUser || tool || classified.approval || classified.precondition || classified.structured;
    if (tool && extracted.text.length > maxToolResultChars) largeToolResults++;
    const content = tool && extracted.text.length > maxToolResultChars ? `[large tool result omitted (${extracted.text.length} chars)]` : extracted.text;
    candidates.push({
      index,
      message,
      content,
      images: extracted.images,
      approval: classified.approval,
      precondition: classified.precondition,
      structured: classified.structured,
      tool,
      required,
      priority: latestUser ? 0 : classified.approval || classified.precondition || classified.structured ? 1 : tool ? 2 : message.role === "system" ? 3 : 4,
      metadata: classified.metadata
    });
  }
  const selected = /* @__PURE__ */ new Map();
  for (const candidate of candidates.filter((item) => item.required)) selected.set(candidate.index, candidate);
  for (const candidate of candidates.filter((item) => !item.required).slice(-keepRecentMessages)) selected.set(candidate.index, candidate);
  const ordered = [...selected.values()].sort((a, b) => a.index - b.index);
  const allocation = [...ordered].sort((a, b) => a.priority - b.priority || a.index - b.index);
  const output = /* @__PURE__ */ new Map();
  let estimatedTextTokens = 0;
  for (const candidate of allocation) {
    const cap = candidate.tool ? maxToolResultChars : maxMessageChars;
    let content = truncate(candidate.content, cap);
    let safe = toSafeMessage(candidate, content);
    const remaining = maxTextTokens - estimatedTextTokens;
    if (messageTokens(safe) > remaining) {
      let low = 0;
      let high = content.length;
      let best = "";
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const attempt = toSafeMessage(candidate, truncate(content, middle));
        if (messageTokens(attempt) <= remaining) {
          best = truncate(content, middle);
          low = middle + 1;
        } else high = middle - 1;
      }
      content = best;
      safe = toSafeMessage(candidate, content);
    }
    const tokens = messageTokens(safe);
    if (tokens > remaining) {
      if (candidate.required) throw new RangeError("required working-context state exceeds the available 4K text budget");
      continue;
    }
    output.set(candidate.index, safe);
    estimatedTextTokens += tokens;
  }
  const resultMessages = ordered.filter((candidate) => output.has(candidate.index)).map((candidate) => output.get(candidate.index));
  const droppedOldMessages = candidates.filter((candidate) => !selected.has(candidate.index)).length + ordered.filter((candidate) => !output.has(candidate.index)).length;
  const retained = {
    latestUserRequest: latestUserIndex >= 0 && output.has(latestUserIndex),
    structuredObservations: resultMessages.filter((message) => message.metadata?.structuredObservation === true).length,
    toolEssentials: resultMessages.filter((message) => message.role === "tool" || message.tool_call_id !== void 0 || message.tool_calls !== void 0).length,
    approvalEssentials: resultMessages.filter((message) => message.metadata?.approval !== void 0 || message.metadata?.approved !== void 0).length,
    preconditionEssentials: resultMessages.filter((message) => message.metadata?.precondition !== void 0 || message.metadata?.before_sha256 !== void 0 || message.metadata?.after_sha256 !== void 0).length
  };
  return {
    messages: resultMessages,
    workingContext: resultMessages,
    maxContextTokens,
    reservedVisualTokens,
    maxTextTokens,
    estimatedTextTokens,
    estimatedContextTokens: estimatedTextTokens + reservedVisualTokens,
    withinBudget: estimatedTextTokens + reservedVisualTokens <= maxContextTokens,
    dropped: { reasoning: reasoningDropped, largeToolResults, images: imageCount, oldImages: imageCount, oldMessages: droppedOldMessages },
    retained
  };
}

// test/vision-budget.ts
function testVisionBudgetTiers() {
  const tiers = [512, 768, 1024];
  import_strict.default.equal(DEFAULT_VISION_TOKEN_BUDGET, 512);
  let previous = 0;
  for (const tier of tiers) {
    const first = selectVisionBudget(3508, 2480, tier);
    const second = selectVisionBudget({ width: 3508, height: 2480, maxVisualTokens: tier });
    import_strict.default.deepStrictEqual(first, second, `budget ${tier} must be deterministic for positional/object calls`);
    import_strict.default.equal(first.maxVisualTokens, tier);
    import_strict.default.equal(first.visualTokenFactor, QWEN_VISION_FACTOR);
    import_strict.default.equal(first.estimationBasis, "qwen-factor-32-grid-estimate");
    import_strict.default.equal(first.processorReported, false);
    import_strict.default.equal(first.width % QWEN_VISION_FACTOR, 0);
    import_strict.default.equal(first.height % QWEN_VISION_FACTOR, 0);
    import_strict.default.ok(first.estimatedVisualTokens <= tier);
    import_strict.default.equal(first.estimatedTokens, first.estimatedVisualTokens);
    import_strict.default.ok(first.estimatedVisualTokens >= previous);
    previous = first.estimatedVisualTokens;
  }
  import_strict.default.equal(selectVisionBudget(1024, 1024, 513).maxVisualTokens, 768, "intermediate request rounds to the next safe tier");
  import_strict.default.equal(selectVisionBudget(1024, 1024, 1).maxVisualTokens, 512);
  import_strict.default.throws(() => selectVisionBudget(1024, 1024, 1025), /exceeds the supported 4K budget/u);
  import_strict.default.throws(() => selectVisionBudget(0, 1024, 512), /width must be a positive safe integer/u);
  import_strict.default.throws(() => selectVisionBudget(1024, Number.MAX_SAFE_INTEGER, 512), /safe arithmetic range/u);
}
function testQwenEstimate() {
  import_strict.default.equal(estimateQwenVisualTokens(640, 320), 200);
  import_strict.default.equal(estimateQwenVisualTokens(641, 321), 231, "arbitrary dimensions use conservative ceil grid arithmetic");
  import_strict.default.throws(() => estimateQwenVisualTokens(0, 320), /width must be a positive safe integer/u);
}
function testActiveToolAllowlist() {
  const tools = [
    { name: "open_company", description: "fixture opener" },
    { name: "host.open_company", description: "different qualified tool" },
    { name: "run_command", description: "not needed for vision" }
  ];
  import_strict.default.deepStrictEqual(activeToolAllowlist(tools), [tools[0]]);
  import_strict.default.deepStrictEqual(activeToolAllowlist(tools, ["host.open_company"]), [tools[1]]);
  import_strict.default.deepStrictEqual(activeToolAllowlist(tools, []), []);
  import_strict.default.deepStrictEqual(MINIMAL_ACTIVE_TOOL_ALLOWLIST, ["open_company"]);
}
function testContextPruning() {
  const giantResult = "sensitive tool payload ".repeat(500);
  const imageData = `data:image/png;base64,${"A".repeat(5e3)}`;
  const messages = [
    { role: "user", content: "old request that may be removed" },
    { role: "assistant", kind: "reasoning", content: "private chain of thought that must not persist" },
    { role: "assistant", content: `old screenshot context ${imageData}` },
    {
      role: "tool",
      name: "open_company",
      tool_call_id: "call-open-1",
      content: giantResult,
      metadata: {
        status: "succeeded",
        before_sha256: "before-hash",
        after_sha256: "after-hash",
        path: "fixture.xlsx"
      }
    },
    {
      role: "observation",
      kind: "structured-observation",
      content: { observation: "cell B3 has a red fill", image_url: imageData },
      metadata: { structuredObservation: true, relevant: true }
    },
    {
      role: "event",
      kind: "approval.resolved",
      content: "approval retained for provenance",
      metadata: { approval: "approved", approved: true, outcome: "approved" }
    },
    {
      role: "event",
      kind: "precondition",
      content: "target unchanged before execution",
      metadata: { precondition: "unchanged", before_sha256: "before-hash" }
    },
    { role: "user", content: "Open the company workbook and report the visible issue." }
  ];
  const result = pruneWorkingContext(messages, {
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    reservedVisualTokens: DEFAULT_RESERVED_VISUAL_TOKENS,
    keepRecentMessages: 1,
    maxToolResultChars: 100,
    ephemeralContent: [
      { type: "text", text: "ephemeral screenshot" },
      { type: "image", mediaType: "image/png", image: new Uint8Array([1, 2, 3]) }
    ]
  });
  import_strict.default.equal(result.withinBudget, true);
  import_strict.default.ok(result.estimatedContextTokens <= DEFAULT_MAX_CONTEXT_TOKENS);
  import_strict.default.equal(result.retained.latestUserRequest, true);
  import_strict.default.ok(result.retained.structuredObservations >= 1);
  import_strict.default.ok(result.retained.toolEssentials >= 1);
  import_strict.default.ok(result.retained.approvalEssentials >= 1);
  import_strict.default.ok(result.retained.preconditionEssentials >= 1);
  import_strict.default.ok(result.dropped.reasoning >= 1);
  import_strict.default.ok(result.dropped.largeToolResults >= 1);
  import_strict.default.ok(result.dropped.images >= 2);
  import_strict.default.ok(result.dropped.oldImages >= 2);
  import_strict.default.ok(result.messages.every((message) => !Object.prototype.hasOwnProperty.call(message, "image_url")));
  import_strict.default.ok(result.messages.every((message) => !Object.prototype.hasOwnProperty.call(message, "images")));
  const serialized = JSON.stringify(result.messages);
  import_strict.default.ok(!serialized.includes("data:image/"));
  import_strict.default.ok(!serialized.includes("A".repeat(100)), "image/base64 bytes must not survive pruning");
  import_strict.default.ok(!serialized.includes("sensitive tool payload ".repeat(20)), "large tool result must not survive pruning");
  const latest = result.messages.find((message) => message.role === "user" && message.content.includes("Open the company"));
  import_strict.default.ok(latest);
  const tool = result.messages.find((message) => message.role === "tool");
  import_strict.default.equal(tool?.metadata?.before_sha256, "before-hash");
  import_strict.default.equal(tool?.metadata?.after_sha256, "after-hash");
  import_strict.default.equal(tool?.metadata?.path, "fixture.xlsx");
  import_strict.default.equal(result.workingContext, result.messages);
}
function testContextFailFast() {
  import_strict.default.throws(() => pruneWorkingContext([{ role: "user", content: "request" }], { maxContextTokens: 4097 }), /maxContextTokens/u);
  import_strict.default.throws(() => pruneWorkingContext([{ role: "user", content: "request" }], { reservedVisualTokens: 2048 }), /supported 4K visual tier/u);
  import_strict.default.throws(() => pruneWorkingContext([{ role: "user", content: "request" }], { maxContextTokens: 8, reservedVisualTokens: 8 }), /required working-context state/u);
}
testVisionBudgetTiers();
testQwenEstimate();
testActiveToolAllowlist();
testContextPruning();
testContextFailFast();
console.log("PASS vision-budget");
