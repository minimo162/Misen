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

// test/request-telemetry.ts
var import_strict = __toESM(require("node:assert/strict"));

// src/request-telemetry.ts
var REQUEST_TELEMETRY_SCHEMA_VERSION = "misen.request-telemetry/v1";
var PRUNING_REASON_CATEGORIES = [
  "reasoning",
  "largeToolResults",
  "images",
  "oldImages",
  "oldMessages",
  // Context-pruner implementations may report these more granular buckets.
  // They are labels only; no content may be attached to a reason.
  "assistant",
  "toolPairs",
  "toolResults",
  "protocol",
  "base64"
];
var IDENTIFIER_MAX_LENGTH = 256;
var PARAMETER_MAX_COUNT = 256;
var TOOL_MAX_COUNT = 256;
var RESULT_CONTEXT_MAX_COUNT = 256;
var METADATA_KEY_MAX_COUNT = 128;
var MAX_SAFE_METADATA_STRING_LENGTH = 160;
var FORBIDDEN_KEY_RE = /^(?:prompt|reason(?:ing)?|thought|analysis|chain[_-]?of[_-]?thought|credential|secret|password|passwd|api[_-]?key|authorization|cookie|image|base64|raw|message|content|completion|response|argument|input[_-]?text|output[_-]?text)(?:$|[_-])/iu;
var FORBIDDEN_VALUE_RE = /(?:data:image\/[a-z0-9.+-]+;base64,|-----BEGIN [^-]+-----|(?:^|\b)(?:sk-[a-z0-9]|pk-[a-z0-9]|ghp_[a-z0-9]|github_pat_|xox[baprs]-|bearer\s+|AIza[0-9a-z_-]|(?:secret|credential|password|authorization)[_-]?))/iu;
var CONTROL_RE = /[\u0000-\u001f\u007f]/u;
function looksLikeEncodedBlob(value) {
  if (value.length < 32 || !/^[A-Za-z0-9+/=_-]+$/u.test(value)) return false;
  if (/^[0-9a-f-]+$/iu.test(value)) return false;
  if (value.includes("-")) return false;
  return value.length >= 32;
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownKeys(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("telemetry metadata cannot contain symbol keys");
  return Object.keys(value);
}
function rejectUnknownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of ownKeys(value)) {
    if (!allowedSet.has(key) || FORBIDDEN_KEY_RE.test(key)) {
      throw new TypeError(`${label} contains an unsafe key: ${key}`);
    }
  }
}
function safeString(value, label, maxLength = IDENTIFIER_MAX_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  if (CONTROL_RE.test(value) || FORBIDDEN_VALUE_RE.test(value) || looksLikeEncodedBlob(value)) {
    throw new TypeError(`${label} contains forbidden or secret-like content`);
  }
  return value;
}
function safeMetadataKey(value, label) {
  return safeString(value, label, MAX_SAFE_METADATA_STRING_LENGTH);
}
function safeCount(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
function safeElapsed(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }
  return value;
}
function safeToken(value, label) {
  if (value === void 0 || value === null) return null;
  return safeCount(value, label);
}
function safeTokenUsage(value) {
  if (value === void 0) {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedInputTokens: null };
  }
  if (!isPlainObject(value)) throw new TypeError("provider usage must be a plain metadata object");
  rejectUnknownKeys(value, ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"], "provider usage");
  return {
    inputTokens: safeToken(value.inputTokens, "inputTokens"),
    outputTokens: safeToken(value.outputTokens, "outputTokens"),
    reasoningTokens: safeToken(value.reasoningTokens, "reasoningTokens"),
    cachedInputTokens: safeToken(value.cachedInputTokens, "cachedInputTokens")
  };
}
function safeToolDefinition(value, index) {
  if (!isPlainObject(value)) throw new TypeError(`exposedToolDefs[${index}] must be a plain metadata object`);
  rejectUnknownKeys(value, ["name", "parameterNames", "parameterCount"], `exposedToolDefs[${index}]`);
  const name = safeString(value.name, `exposedToolDefs[${index}].name`);
  let parameterNames;
  if (value.parameterNames !== void 0) {
    if (!Array.isArray(value.parameterNames) || value.parameterNames.length > PARAMETER_MAX_COUNT) {
      throw new RangeError(`exposedToolDefs[${index}].parameterNames exceeds the safe bound`);
    }
    parameterNames = value.parameterNames.map(
      (parameter, parameterIndex) => safeMetadataKey(parameter, `exposedToolDefs[${index}].parameterNames[${parameterIndex}]`)
    );
    if (new Set(parameterNames).size !== parameterNames.length) {
      throw new TypeError(`exposedToolDefs[${index}].parameterNames must be unique`);
    }
  }
  const parameterCount = value.parameterCount === void 0 ? parameterNames?.length : safeCount(value.parameterCount, `exposedToolDefs[${index}].parameterCount`, PARAMETER_MAX_COUNT);
  if (parameterNames !== void 0 && parameterCount !== parameterNames.length) {
    throw new RangeError(`exposedToolDefs[${index}] parameterCount does not match parameterNames`);
  }
  return Object.freeze({
    name,
    ...parameterNames !== void 0 ? { parameterNames: Object.freeze(parameterNames.slice()) } : {},
    ...parameterCount !== void 0 ? { parameterCount } : {}
  });
}
function safeToolDefinitions(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > TOOL_MAX_COUNT) throw new RangeError("exposedToolDefs exceeds the safe bound");
  return value.map((item, index) => safeToolDefinition(item, index));
}
function safeResultContext(value, index) {
  if (!isPlainObject(value)) throw new TypeError(`toolResultContext[${index}] must be a plain metadata object`);
  rejectUnknownKeys(value, ["toolName", "status", "resultChars", "metadataKeys"], `toolResultContext[${index}]`);
  const toolName = safeString(value.toolName, `toolResultContext[${index}].toolName`);
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "denied" && value.status !== "unknown") {
    throw new TypeError(`toolResultContext[${index}].status is not a supported status`);
  }
  const resultChars = value.resultChars === void 0 || value.resultChars === null ? null : safeCount(value.resultChars, `toolResultContext[${index}].resultChars`, Number.MAX_SAFE_INTEGER);
  let metadataKeys;
  if (value.metadataKeys !== void 0) {
    if (!Array.isArray(value.metadataKeys) || value.metadataKeys.length > METADATA_KEY_MAX_COUNT) {
      throw new RangeError(`toolResultContext[${index}].metadataKeys exceeds the safe bound`);
    }
    metadataKeys = value.metadataKeys.map((key, keyIndex) => safeMetadataKey(key, `toolResultContext[${index}].metadataKeys[${keyIndex}]`));
    if (new Set(metadataKeys).size !== metadataKeys.length) {
      throw new TypeError(`toolResultContext[${index}].metadataKeys must be unique`);
    }
  }
  return Object.freeze({
    toolName,
    status: value.status,
    resultChars,
    ...metadataKeys !== void 0 ? { metadataKeys: Object.freeze(metadataKeys.slice()) } : {}
  });
}
function safeResultContexts(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > RESULT_CONTEXT_MAX_COUNT) throw new RangeError("toolResultContext exceeds the safe bound");
  return value.map((item, index) => safeResultContext(item, index));
}
function zeroPruningReasons() {
  return {
    reasoning: 0,
    largeToolResults: 0,
    images: 0,
    oldImages: 0,
    oldMessages: 0,
    assistant: 0,
    toolPairs: 0,
    toolResults: 0,
    protocol: 0,
    base64: 0
  };
}
var PRUNING_REASON_SET = new Set(PRUNING_REASON_CATEGORIES);
var PRUNING_REASON_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
function safePruningReasonKey(value) {
  if (!PRUNING_REASON_KEY_RE.test(value) || FORBIDDEN_KEY_RE.test(value) && !PRUNING_REASON_SET.has(value)) {
    throw new TypeError(`pruning.reasons contains an unsafe category: ${value}`);
  }
  return value;
}
function safePruning(value) {
  if (value === void 0) return Object.freeze({ count: 0, reasons: Object.freeze(zeroPruningReasons()) });
  if (!isPlainObject(value)) throw new TypeError("pruning must be a plain metadata object");
  rejectUnknownKeys(value, ["count", "reasons"], "pruning");
  const reasons = zeroPruningReasons();
  if (value.reasons !== void 0) {
    if (!isPlainObject(value.reasons)) throw new TypeError("pruning.reasons must be a plain metadata object");
    for (const key of ownKeys(value.reasons)) {
      const reason = safePruningReasonKey(key);
      const count2 = safeCount(value.reasons[key], `pruning.reasons.${reason}`);
      reasons[reason] = count2;
    }
  }
  const calculatedCount = Object.values(reasons).reduce((sum, count2) => sum + count2, 0);
  const count = value.count === void 0 ? calculatedCount : safeCount(value.count, "pruning.count");
  if (count !== calculatedCount) throw new RangeError("pruning.count must equal the sum of pruning.reasons");
  return Object.freeze({ count, reasons: Object.freeze(reasons) });
}
function utf8Bytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new TypeError("telemetry metadata is not JSON serializable");
  return new TextEncoder().encode(serialized).byteLength;
}
function approximateToolSchemaBytes(definitions) {
  const sanitized = safeToolDefinitions(definitions);
  return utf8Bytes(sanitized?.map((definition) => ({
    name: definition.name,
    ...definition.parameterNames !== void 0 ? { parameterNames: [...definition.parameterNames] } : {},
    ...definition.parameterCount !== void 0 ? { parameterCount: definition.parameterCount } : {}
  })) ?? []);
}
function approximateToolResultContextBytes(context) {
  const sanitized = safeResultContexts(context);
  return utf8Bytes(sanitized?.map((result) => ({
    toolName: result.toolName,
    status: result.status,
    resultChars: result.resultChars,
    ...result.metadataKeys !== void 0 ? { metadataKeys: [...result.metadataKeys] } : {}
  })) ?? []);
}
function safeBeginInput(input) {
  if (!isPlainObject(input)) throw new TypeError("request telemetry input must be a plain metadata object");
  rejectUnknownKeys(input, ["requestIndex", "runId", "provider", "model", "workingMessageCount", "exposedToolDefs", "exposedToolCount", "toolSchemaBytes", "toolResultContext", "toolResultContextBytes", "pruning"], "request telemetry input");
  const requestIndex = safeCount(input.requestIndex, "requestIndex");
  const runId = safeString(input.runId, "runId");
  const provider = safeString(input.provider, "provider");
  const model = safeString(input.model, "model");
  const workingMessageCount = safeCount(input.workingMessageCount, "workingMessageCount");
  const toolDefs = safeToolDefinitions(input.exposedToolDefs);
  const resultContext = safeResultContexts(input.toolResultContext);
  const exposedToolCount = input.exposedToolCount === void 0 ? toolDefs?.length ?? 0 : safeCount(input.exposedToolCount, "exposedToolCount", TOOL_MAX_COUNT);
  if (toolDefs !== void 0 && exposedToolCount !== toolDefs.length) {
    throw new RangeError("exposedToolCount must equal exposedToolDefs.length");
  }
  const toolSchemaBytes = input.toolSchemaBytes === void 0 || input.toolSchemaBytes === null ? input.toolSchemaBytes : safeCount(input.toolSchemaBytes, "toolSchemaBytes");
  const toolResultContextBytes = input.toolResultContextBytes === void 0 || input.toolResultContextBytes === null ? input.toolResultContextBytes : safeCount(input.toolResultContextBytes, "toolResultContextBytes");
  const pruning = safePruning(input.pruning);
  return {
    input: Object.freeze({ requestIndex, runId, provider, model, workingMessageCount, exposedToolCount, toolSchemaBytes, toolResultContextBytes }),
    toolDefs,
    resultContext,
    toolSchemaBytes,
    toolResultContextBytes,
    pruning
  };
}
function safeClock(now) {
  const value = now();
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError("telemetry clock must return a finite number");
  return value;
}
function freezeRecord(record) {
  return Object.freeze({
    ...record,
    tokenUsage: Object.freeze({ ...record.tokenUsage }),
    pruning: Object.freeze({ count: record.pruning.count, reasons: Object.freeze({ ...record.pruning.reasons }) })
  });
}
var RequestTelemetryCollector = class {
  #now;
  #records = [];
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
  }
  /** Start one model request; no input or raw content is retained. */
  beginRequest(input) {
    const safe = safeBeginInput(input);
    const startedAt = safeClock(this.#now);
    let finished = false;
    const finish = (usage) => {
      if (finished) throw new Error("request telemetry cannot be finished twice");
      const tokenUsage = safeTokenUsage(usage);
      const elapsedMs = safeElapsed(Math.max(0, safeClock(this.#now) - startedAt));
      const record = freezeRecord({
        schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
        requestIndex: safe.input.requestIndex,
        runId: safe.input.runId,
        provider: safe.input.provider,
        model: safe.input.model,
        elapsedMs,
        tokenUsage,
        workingMessageCount: safe.input.workingMessageCount,
        exposedToolCount: safe.input.exposedToolCount ?? (safe.toolDefs?.length ?? 0),
        toolSchemaBytes: safe.toolSchemaBytes !== void 0 ? safe.toolSchemaBytes : safe.toolDefs === void 0 ? null : approximateToolSchemaBytes(safe.toolDefs),
        toolResultContextBytes: safe.toolResultContextBytes !== void 0 ? safe.toolResultContextBytes : safe.resultContext === void 0 ? null : approximateToolResultContextBytes(safe.resultContext),
        pruning: safe.pruning
      });
      finished = true;
      this.#records.push(record);
      return record;
    };
    return Object.freeze({ finish });
  }
  /** Convenience for callers that do not need to retain a request handle. */
  finishRequest(request, usage) {
    if (!request || typeof request.finish !== "function") throw new TypeError("request handle is invalid");
    return request.finish(usage);
  }
  /** Read-only insertion-order snapshot; records are frozen at completion. */
  records() {
    return this.#records.slice();
  }
  clear() {
    this.#records.length = 0;
  }
};
function createRequestTelemetryCollector(options = {}) {
  return new RequestTelemetryCollector(options);
}
function createRequestTelemetryRecord(input, usage) {
  if (!isPlainObject(input)) throw new TypeError("request telemetry input must be a plain metadata object");
  const { elapsedMs, ...beginInput2 } = input;
  const safe = safeBeginInput(beginInput2);
  const tokenUsage = safeTokenUsage(usage);
  return freezeRecord({
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    requestIndex: safe.input.requestIndex,
    runId: safe.input.runId,
    provider: safe.input.provider,
    model: safe.input.model,
    elapsedMs: safeElapsed(elapsedMs),
    tokenUsage,
    workingMessageCount: safe.input.workingMessageCount,
    exposedToolCount: safe.input.exposedToolCount ?? (safe.toolDefs?.length ?? 0),
    toolSchemaBytes: safe.toolSchemaBytes !== void 0 ? safe.toolSchemaBytes : safe.toolDefs === void 0 ? null : approximateToolSchemaBytes(safe.toolDefs),
    toolResultContextBytes: safe.toolResultContextBytes !== void 0 ? safe.toolResultContextBytes : safe.resultContext === void 0 ? null : approximateToolResultContextBytes(safe.resultContext),
    pruning: safe.pruning
  });
}
function parseRequestTelemetryRecord(value) {
  if (!isPlainObject(value)) throw new TypeError("request telemetry record must be a plain metadata object");
  const requiredKeys = [
    "schemaVersion",
    "requestIndex",
    "runId",
    "provider",
    "model",
    "elapsedMs",
    "tokenUsage",
    "workingMessageCount",
    "exposedToolCount",
    "toolSchemaBytes",
    "toolResultContextBytes",
    "pruning"
  ];
  rejectUnknownKeys(value, requiredKeys, "request telemetry record");
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) throw new TypeError(`request telemetry record is missing ${key}`);
  if (value.schemaVersion !== REQUEST_TELEMETRY_SCHEMA_VERSION) throw new TypeError("request telemetry schemaVersion is unsupported");
  const nullableCount = (candidate, label) => candidate === null ? null : safeCount(candidate, label);
  return freezeRecord({
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    requestIndex: safeCount(value.requestIndex, "requestIndex"),
    runId: safeString(value.runId, "runId"),
    provider: safeString(value.provider, "provider"),
    model: safeString(value.model, "model"),
    elapsedMs: safeElapsed(value.elapsedMs),
    tokenUsage: safeTokenUsage(value.tokenUsage),
    workingMessageCount: safeCount(value.workingMessageCount, "workingMessageCount"),
    exposedToolCount: safeCount(value.exposedToolCount, "exposedToolCount", TOOL_MAX_COUNT),
    toolSchemaBytes: nullableCount(value.toolSchemaBytes, "toolSchemaBytes"),
    toolResultContextBytes: nullableCount(value.toolResultContextBytes, "toolResultContextBytes"),
    pruning: safePruning(value.pruning)
  });
}

// test/request-telemetry.ts
function beginInput(overrides = {}) {
  return {
    requestIndex: 2,
    runId: "run-56-fixture",
    provider: "fixture-provider",
    model: "fixture-model",
    workingMessageCount: 4,
    exposedToolDefs: [
      { name: "open_company", parameterNames: ["path"], parameterCount: 1 },
      { name: "read_status", parameterNames: ["scope"], parameterCount: 1 }
    ],
    toolResultContext: [{ toolName: "open_company", status: "succeeded", resultChars: 42, metadataKeys: ["status", "path"] }],
    pruning: {
      count: 3,
      reasons: { reasoning: 1, largeToolResults: 1, oldMessages: 1 }
    },
    ...overrides
  };
}
function testPersistenceRevalidation() {
  const record = createRequestTelemetryRecord({ ...beginInput(), elapsedMs: 12 }, { inputTokens: 3 });
  import_strict.default.deepEqual(parseRequestTelemetryRecord(JSON.parse(JSON.stringify(record))), record);
  import_strict.default.throws(() => parseRequestTelemetryRecord({ ...record, rawPrompt: "do not persist" }), /unsafe key/u);
  import_strict.default.throws(() => parseRequestTelemetryRecord({ ...record, tokenUsage: { ...record.tokenUsage, content: "raw result" } }), /unsafe key/u);
}
function testDeterministicRequestAndProviderUsage() {
  const ticks = [1e3, 1125];
  const collector = createRequestTelemetryCollector({ now: () => ticks.shift() ?? 1125 });
  const request = collector.beginRequest(beginInput());
  const record = request.finish({ inputTokens: 42, outputTokens: 13, reasoningTokens: 5, cachedInputTokens: 7 });
  import_strict.default.equal(record.schemaVersion, "misen.request-telemetry/v1");
  import_strict.default.equal(record.requestIndex, 2);
  import_strict.default.equal(record.runId, "run-56-fixture");
  import_strict.default.equal(record.provider, "fixture-provider");
  import_strict.default.equal(record.model, "fixture-model");
  import_strict.default.equal(record.elapsedMs, 125);
  import_strict.default.deepEqual(record.tokenUsage, {
    inputTokens: 42,
    outputTokens: 13,
    reasoningTokens: 5,
    cachedInputTokens: 7
  });
  import_strict.default.equal(record.workingMessageCount, 4);
  import_strict.default.equal(record.exposedToolCount, 2);
  import_strict.default.equal(record.toolSchemaBytes, approximateToolSchemaBytes(beginInput().exposedToolDefs ?? []));
  import_strict.default.equal(record.toolResultContextBytes, approximateToolResultContextBytes(beginInput().toolResultContext ?? []));
  import_strict.default.deepEqual(record.pruning, {
    count: 3,
    reasons: {
      reasoning: 1,
      largeToolResults: 1,
      images: 0,
      oldImages: 0,
      oldMessages: 1,
      assistant: 0,
      toolPairs: 0,
      toolResults: 0,
      protocol: 0,
      base64: 0
    }
  });
  import_strict.default.deepEqual(collector.records(), [record]);
  import_strict.default.throws(() => request.finish(), /finished twice/u);
}
function testUnknownTokensStayNull() {
  const record = createRequestTelemetryRecord({ ...beginInput({ exposedToolDefs: void 0, toolResultContext: void 0, pruning: void 0 }), elapsedMs: 8 });
  import_strict.default.deepEqual(record.tokenUsage, {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null
  });
  import_strict.default.equal(record.toolSchemaBytes, null);
  import_strict.default.equal(record.toolResultContextBytes, null);
  import_strict.default.equal(record.exposedToolCount, 0);
}
function testCallerComputedSizesAreAcceptedWithoutRetainingInputs() {
  const record = createRequestTelemetryRecord({
    ...beginInput({ exposedToolDefs: void 0, toolResultContext: void 0, toolSchemaBytes: 901, toolResultContextBytes: 73 }),
    elapsedMs: 3
  });
  import_strict.default.equal(record.toolSchemaBytes, 901);
  import_strict.default.equal(record.toolResultContextBytes, 73);
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput({ toolSchemaBytes: -1 }), elapsedMs: 1 }), /toolSchemaBytes/u);
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput({ toolResultContextBytes: Number.POSITIVE_INFINITY }), elapsedMs: 1 }), /toolResultContextBytes/u);
}
function testSizesAreDeterministicAndUtf8Aware() {
  const definitions = [
    { name: "\u4F1A\u793E\u3092\u958B\u304F", parameterNames: ["\u30D1\u30B9"], parameterCount: 1 }
  ];
  const context = [
    { toolName: "\u4F1A\u793E\u3092\u958B\u304F", status: "failed", resultChars: 120, metadataKeys: ["\u72B6\u614B"] }
  ];
  const schemaBytes = approximateToolSchemaBytes(definitions);
  const resultBytes = approximateToolResultContextBytes(context);
  import_strict.default.equal(schemaBytes, approximateToolSchemaBytes(definitions));
  import_strict.default.equal(resultBytes, approximateToolResultContextBytes(context));
  import_strict.default.ok(schemaBytes > JSON.stringify([{ name: "\u4F1A\u793E\u3092\u958B\u304F", parameterNames: ["\u30D1\u30B9"], parameterCount: 1 }]).length);
  import_strict.default.ok(resultBytes > JSON.stringify([{ toolName: "\u4F1A\u793E\u3092\u958B\u304F", status: "failed", resultChars: 120, metadataKeys: ["\u72B6\u614B"] }]).length);
}
function testPruningReasonsAndInputBounds() {
  import_strict.default.deepEqual(PRUNING_REASON_CATEGORIES, ["reasoning", "largeToolResults", "images", "oldImages", "oldMessages", "assistant", "toolPairs", "toolResults", "protocol", "base64"]);
  const extensible = createRequestTelemetryRecord({ ...beginInput({ pruning: { count: 2, reasons: { toolPairs: 1, protocol: 1 } } }), elapsedMs: 1 });
  import_strict.default.equal(extensible.pruning.reasons.toolPairs, 1);
  import_strict.default.equal(extensible.pruning.reasons.protocol, 1);
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput({ pruning: { count: 1, reasons: { reasoning: 2 } } }), elapsedMs: 1 }), /sum of pruning/u);
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput({ workingMessageCount: -1 }), elapsedMs: 1 }), /workingMessageCount/u);
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput({ exposedToolCount: 1 }), elapsedMs: 1 }), /exposedToolCount/u);
}
function testUnsafeContentIsRejectedAndNeverRetained() {
  const unsafeCases = [
    { ...beginInput(), prompt: "private request" },
    { ...beginInput(), exposedToolDefs: [{ name: "read_status", description: "raw prompt text" }] },
    { ...beginInput(), toolResultContext: [{ toolName: "read_status", status: "succeeded", content: "private result" }] },
    { ...beginInput(), runId: "data:image/png;base64,AAAA" },
    { ...beginInput(), model: "sk-secret-value" },
    { ...beginInput(), provider: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789" }
  ];
  for (const value of unsafeCases) {
    import_strict.default.throws(() => createRequestTelemetryRecord({ ...value, elapsedMs: 1 }), /unsafe|forbidden|secret-like|bounded/u);
  }
  import_strict.default.throws(() => createRequestTelemetryRecord({ ...beginInput(), elapsedMs: 1 }, { inputTokens: "prompt" }), /inputTokens/u);
  const definitions = [{ name: "read_status", parameterNames: ["scope"] }];
  const contexts = [{ toolName: "read_status", status: "succeeded", resultChars: 10 }];
  const input = beginInput({ exposedToolDefs: definitions, toolResultContext: contexts });
  const record = createRequestTelemetryRecord({ ...input, elapsedMs: 1 });
  definitions[0].name = "mutated-after-start";
  contexts[0].resultChars = 99;
  import_strict.default.equal(record.exposedToolCount, 1);
  import_strict.default.ok(!JSON.stringify(record).includes("mutated-after-start"));
  import_strict.default.ok(!JSON.stringify(record).includes("private"));
}
function testClockGoingBackwardsClampsElapsed() {
  const ticks = [50, 25];
  const request = createRequestTelemetryCollector({ now: () => ticks.shift() }).beginRequest(beginInput());
  import_strict.default.equal(request.finish().elapsedMs, 0);
}
testDeterministicRequestAndProviderUsage();
testPersistenceRevalidation();
testUnknownTokensStayNull();
testCallerComputedSizesAreAcceptedWithoutRetainingInputs();
testSizesAreDeterministicAndUtf8Aware();
testPruningReasonsAndInputBounds();
testUnsafeContentIsRejectedAndNeverRetained();
testClockGoingBackwardsClampsElapsed();
console.log("PASS request-telemetry");
