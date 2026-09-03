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

// test/computer-use-demo.ts
var import_strict = __toESM(require("node:assert/strict"));
var import_node_crypto2 = require("node:crypto");

// src/computer-use-demo.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_zlib = require("node:zlib");
var COMPUTER_USE_DEMO_ROUTE = "/computer-use-demo.html";
var COMPUTER_USE_DEMO_TITLE = "Synthetic Business Directory";
var COMPUTER_USE_DEMO_PROMPT = "\u73FE\u5728\u306E\u696D\u52D9\u753B\u9762\u306E\u30B9\u30AF\u30EA\u30FC\u30F3\u30B7\u30E7\u30C3\u30C8\u3060\u3051\u3092\u78BA\u8A8D\u3057\u3001\u5BFE\u5FDC\u304C\u5FC5\u8981\u306A\u4F1A\u793E\u3092\u958B\u3044\u3066\u304F\u3060\u3055\u3044\u3002DOM \u30C6\u30AD\u30B9\u30C8\u3084\u5185\u90E8\u72B6\u614B\u306F\u53C2\u7167\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002";
var COMPUTER_USE_SCREEN_MEDIA_TYPE = "image/png";
var COMPUTER_USE_SCREEN_WIDTH = 960;
var COMPUTER_USE_SCREEN_HEIGHT = 600;
var DEFAULT_SEED = 53028;
var ComputerUseActionError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ComputerUseActionError";
    this.code = code;
  }
};
var BASE_COMPANIES = Object.freeze([
  { id: "co-amber-17", name: "A\u793E", sector: "Retail", accent: "#2563eb" },
  { id: "co-bronze-29", name: "B\u793E", sector: "Manufacturing", accent: "#7c3aed" },
  { id: "co-cobalt-41", name: "C\u793E", sector: "Logistics", accent: "#0891b2" },
  { id: "co-delta-53", name: "D\u793E", sector: "Services", accent: "#059669" }
]);
function positiveModulo(value, divisor) {
  return (value % divisor + divisor) % divisor;
}
function mixSeed(input) {
  let value = input | 0;
  value = Math.imul(value ^ value >>> 16, 73244475);
  value = Math.imul(value ^ value >>> 16, 73244475);
  return value ^ value >>> 16 | 0;
}
function seededOrder(seed) {
  const ordered = [...BASE_COMPANIES];
  let state = mixSeed(seed);
  for (let index = ordered.length - 1; index > 0; index--) {
    state = Math.imul(state ^ state >>> 13, 1540483477);
    state = state | 0;
    const swapIndex = positiveModulo(state, index + 1);
    const current = ordered[index];
    ordered[index] = ordered[swapIndex];
    ordered[swapIndex] = current;
  }
  return ordered;
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
function normalizeDimension(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(320, Math.min(1920, Math.floor(value)));
}
var SyntheticBusinessScreen = class {
  route = COMPUTER_USE_DEMO_ROUTE;
  title = COMPUTER_USE_DEMO_TITLE;
  width;
  height;
  seed;
  /** Test/orchestration seam; never serialize this value into model input. */
  targetCompanyId;
  companies;
  companyById;
  clock;
  openedCompanyId = null;
  revision = 0;
  constructor(options = {}) {
    this.seed = Number.isFinite(options.seed) ? Math.trunc(options.seed) : DEFAULT_SEED;
    this.width = normalizeDimension(options.width, COMPUTER_USE_SCREEN_WIDTH);
    this.height = normalizeDimension(options.height, COMPUTER_USE_SCREEN_HEIGHT);
    this.companies = Object.freeze(seededOrder(this.seed));
    this.companyById = new Map(this.companies.map((company) => [company.id, company]));
    const targetIndex = positiveModulo(mixSeed(this.seed ^ 21263), this.companies.length);
    this.targetCompanyId = this.companies[targetIndex].id;
    this.clock = options.clock ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  }
  get currentRevision() {
    return this.revision;
  }
  get isOpened() {
    return this.openedCompanyId !== null;
  }
  snapshot() {
    const visibleCompanies = this.companies.map((company) => ({
      ...company,
      status: this.openedCompanyId === company.id ? "opened" : "available",
      visualCue: company.id === this.targetCompanyId ? "attention" : "normal"
    }));
    return {
      route: this.route,
      title: this.title,
      revision: this.revision,
      visibleCompanies,
      openedCompanyId: this.openedCompanyId,
      statusText: this.openedCompanyId === null ? "No company is open" : `Opened ${this.openedCompanyId}`,
      width: this.width,
      height: this.height
    };
  }
  render() {
    const snapshot = this.snapshot();
    return {
      route: this.route,
      title: this.title,
      revision: this.revision,
      stateFingerprint: this.stateFingerprint(),
      html: renderScreenHtml(snapshot),
      width: this.width,
      height: this.height
    };
  }
  captureScreenshot() {
    return {
      bytes: encodeScreenPng(this.snapshot()),
      mediaType: COMPUTER_USE_SCREEN_MEDIA_TYPE,
      width: this.width,
      height: this.height,
      capturedAt: this.clock(),
      stateFingerprint: this.stateFingerprint(),
      ephemeral: true
    };
  }
  /**
   * Opaque version binding for host-side approval/precondition checks.  The
   * underlying state is never sent to the model; callers should compare this
   * value immediately before invoking the structured action.
   */
  stateFingerprint() {
    const visible = this.companies.map((company) => ({
      id: company.id,
      status: this.openedCompanyId === company.id ? "opened" : "available",
      attention: company.id === this.targetCompanyId
    }));
    return import_node_crypto.default.createHash("sha256").update(JSON.stringify({ revision: this.revision, visible }), "utf8").digest("hex");
  }
  openCompany(companyId) {
    const normalized = typeof companyId === "string" ? companyId.trim() : "";
    if (!normalized) throw new ComputerUseActionError("invalid_company_id", "company_id \u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
    if (this.openedCompanyId !== null) {
      throw new ComputerUseActionError("duplicate_action", "\u3053\u306E\u753B\u9762\u3067\u306F open_company \u306F\u65E2\u306B\u5B9F\u884C\u6E08\u307F\u3067\u3059");
    }
    if (!this.companyById.has(normalized)) {
      throw new ComputerUseActionError("company_not_visible", "\u6307\u5B9A\u3055\u308C\u305F\u4F1A\u793E\u30AB\u30FC\u30C9\u306F\u73FE\u5728\u306E\u753B\u9762\u306B\u8868\u793A\u3055\u308C\u3066\u3044\u307E\u305B\u3093");
    }
    if (normalized !== this.targetCompanyId) {
      throw new ComputerUseActionError("wrong_target", "\u753B\u50CF\u3067\u9078\u629E\u3055\u308C\u305F\u4F1A\u793E\u30AB\u30FC\u30C9\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093");
    }
    const beforeRevision = this.revision;
    this.openedCompanyId = normalized;
    this.revision++;
    return {
      action: "open_company",
      changed: true,
      companyId: normalized,
      beforeRevision,
      afterRevision: this.revision,
      route: this.route
    };
  }
};
function createSyntheticBusinessScreen(options = {}) {
  return new SyntheticBusinessScreen(options);
}
function renderSyntheticBusinessScreen(screen) {
  return screen.render();
}
var SyntheticScreenshotProvider = class {
  constructor(screen) {
    this.screen = screen;
  }
  async capture() {
    return this.screen.captureScreenshot();
  }
};
function createScreenshotInputProvider(screen) {
  return new SyntheticScreenshotProvider(screen);
}
function toImageOnlyInput(observation) {
  return {
    bytes: observation.bytes.slice(),
    mediaType: observation.mediaType
  };
}
function createOpenCompanyTool(screen, expectedFingerprint = screen.stateFingerprint()) {
  return {
    name: "open_company",
    description: "\u73FE\u5728\u8868\u793A\u4E2D\u306E\u4F1A\u793E\u30AB\u30FC\u30C9\u3092\u8B58\u5225\u5B50\u3067\u958B\u304F\u69CB\u9020\u5316\u64CD\u4F5C\u3002\u73FE\u5728\u306E\u753B\u9762\u72B6\u614B\u3092\u691C\u8A3C\u3057\u3066\u304B\u30891\u56DE\u3060\u3051\u5B9F\u884C\u3059\u308B",
    kind: "write",
    requiresImage: true,
    parameters: {
      type: "object",
      properties: {
        company_id: {
          type: "string",
          description: "\u73FE\u5728\u306E\u753B\u9762\u306B\u8868\u793A\u3055\u308C\u305F\u4F1A\u793E\u306E\u8B58\u5225\u5B50",
          minLength: 1,
          maxLength: 128
        }
      },
      required: ["company_id"],
      additionalProperties: false
    },
    async run(args, _ctx) {
      if (screen.stateFingerprint() !== expectedFingerprint) {
        throw new ComputerUseActionError("stale_screen", "\u30B9\u30AF\u30EA\u30FC\u30F3\u30B7\u30E7\u30C3\u30C8\u53D6\u5F97\u5F8C\u306B\u753B\u9762\u72B6\u614B\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u5B9F\u884C\u3057\u307E\u305B\u3093\u3067\u3057\u305F");
      }
      const value = args.company_id;
      if (typeof value !== "string") throw new ComputerUseActionError("invalid_company_id", "company_id \u306F\u6587\u5B57\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
      const result = screen.openCompany(value);
      const metadata = {
        changed: result.changed,
        status: "applied_unverified",
        action: result.action,
        companyId: result.companyId,
        beforeRevision: result.beforeRevision,
        afterRevision: result.afterRevision,
        route: result.route
      };
      return ["open_company: succeeded", `\u7D50\u679C\u30E1\u30BF\u30C7\u30FC\u30BF: ${JSON.stringify(metadata)}`].join("\n");
    }
  };
}
function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error("Computer Use demo \u306F\u30AD\u30E3\u30F3\u30BB\u30EB\u3055\u308C\u307E\u3057\u305F");
}
async function runComputerUseDemo(options) {
  const provider = options.screenshotProvider ?? createScreenshotInputProvider(options.screen);
  assertNotAborted(options.signal);
  const initialScreenshot = await provider.capture();
  assertNotAborted(options.signal);
  const decisionValue = await options.decideTarget(toImageOnlyInput(initialScreenshot));
  if (!decisionValue || typeof decisionValue.company_id !== "string" || decisionValue.company_id.trim() === "") {
    throw new ComputerUseActionError("invalid_decision", "\u753B\u50CF\u304B\u3089\u6709\u52B9\u306A company_id \u3092\u6C7A\u5B9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  const decision = { company_id: decisionValue.company_id.trim() };
  const tool = createOpenCompanyTool(options.screen, initialScreenshot.stateFingerprint);
  const action = {
    toolCallId: `computer-use-open-${options.screen.currentRevision + 1}`,
    toolName: "open_company",
    input: decision
  };
  assertNotAborted(options.signal);
  const actionResult = await options.execute(action, tool);
  assertNotAborted(options.signal);
  const postActionScreenshot = await provider.capture();
  assertNotAborted(options.signal);
  const reobservation = options.reobserve ? await options.reobserve(toImageOnlyInput(postActionScreenshot)) : void 0;
  return { initialScreenshot, decision, action, actionResult, postActionScreenshot, reobservation };
}
function renderScreenHtml(snapshot) {
  const cards = snapshot.visibleCompanies.map((company) => {
    const attention = company.visualCue === "attention";
    const cue = attention ? '<span class="attention-badge">\u8981\u78BA\u8A8D</span>' : '<span class="done-badge">\u5B8C\u4E86</span>';
    const state = company.status === "opened" ? "OPEN" : attention ? "\u8981\u78BA\u8A8D" : "\u5B8C\u4E86";
    return [
      `<article class="company-card ${attention ? "attention-card" : ""} ${company.status === "opened" ? "opened-card" : ""}" data-company-id="${escapeHtml(company.id)}">`,
      `<div class="card-top"><span class="company-id">${escapeHtml(company.id)}</span>${cue}</div>`,
      `<h2>${escapeHtml(company.name)}</h2>`,
      `<p>${escapeHtml(company.sector)}</p>`,
      '<span class="action-hint">structured action: open_company</span>',
      `<span class="card-state">${state}</span>`,
      "</article>"
    ].join("");
  }).join("");
  const opened = snapshot.openedCompanyId ? snapshot.visibleCompanies.find((company) => company.id === snapshot.openedCompanyId) : void 0;
  const detail = opened ? `<section id="company-detail" class="detail-panel" aria-live="polite"><p class="detail-kicker">COMPANY DETAIL</p><h2>${escapeHtml(opened.name)} \u8A73\u7D30</h2><p class="detail-id">${escapeHtml(opened.id)}</p><dl><div><dt>\u72B6\u614B</dt><dd>\u8981\u78BA\u8A8D</dd></div><div><dt>\u7406\u7531</dt><dd>\u6DFB\u4ED8\u8CC7\u6599\u672A\u63D0\u51FA</dd></div></dl></section>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(snapshot.title)}</title>
<style>
:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(135deg,#f8fafc,#e8eef8)}
main{max-width:960px;margin:0 auto;padding:20px 32px 24px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
h1{margin:0;font-size:28px;letter-spacing:.01em}.subtitle{margin:8px 0 0;color:#58657a}.route{font:12px ui-monospace,monospace;color:#73819a}
.notice{margin:16px 0 12px;padding:11px 14px;border-radius:12px;background:#fff;border:1px solid #dbe2ef;box-shadow:0 8px 18px #51648612}
.company-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.company-card{position:relative;padding:14px;border:2px solid #d8e0ed;border-radius:15px;background:#fff;min-height:132px;box-shadow:0 8px 18px #51648614}
.company-card.attention-card{border-color:#dc2626;box-shadow:0 0 0 4px #fecaca88,0 12px 24px #51648620}.company-card.opened-card{border-color:#16a34a;background:#f0fdf4}
.card-top{display:flex;justify-content:space-between;align-items:center}.company-id{font:600 12px ui-monospace,monospace;color:#58657a}.attention-badge,.done-badge{padding:4px 8px;border-radius:999px;color:#fff;font-size:11px;font-weight:800;letter-spacing:.08em}.attention-badge{background:#dc2626}.done-badge{background:#16a34a}
h2{margin:10px 0 2px;font-size:21px}.company-card p{margin:0;color:#64748b}.action-hint{display:inline-block;margin-top:10px;padding:6px 9px;border:1px solid #cdd7e7;border-radius:8px;background:#f8fafc;color:#64748b;font:600 10px ui-monospace,monospace}.card-state{float:right;margin-top:17px;color:#64748b;font:600 11px ui-monospace,monospace}
.detail-panel{margin-top:18px;padding:18px 20px;border-radius:14px;background:#172033;color:#fff;border-left:7px solid #dc2626;box-shadow:0 10px 24px #17203338}.detail-kicker{margin:0;color:#fca5a5;font:700 11px ui-monospace,monospace;letter-spacing:.14em}.detail-panel h2{margin:7px 0 0;font-size:26px}.detail-id{margin:2px 0 12px;color:#cbd5e1;font:600 12px ui-monospace,monospace}.detail-panel dl{display:flex;gap:30px;margin:0}.detail-panel dt{color:#cbd5e1;font-size:12px}.detail-panel dd{margin:2px 0 0;color:#fecaca;font-weight:800}.detail-panel dl>div{min-width:170px}
.status{margin-top:18px;padding:12px 14px;border-radius:10px;background:#172033;color:#fff;font:600 13px ui-monospace,monospace}
@media(max-width:680px){main{padding:20px}.company-grid{grid-template-columns:1fr}header{display:block}.route{display:block;margin-top:8px}}
</style></head>
<body><main id="computer-use-demo" data-route="${snapshot.route}" data-revision="${snapshot.revision}" data-synthetic="true">
<header><div><h1>${escapeHtml(snapshot.title)}</h1><p class="subtitle">Visual business card fixture</p></div><span class="route">${escapeHtml(snapshot.route)}</span></header>
<div class="notice">\u30B9\u30AF\u30EA\u30FC\u30F3\u30B7\u30E7\u30C3\u30C8\u3067\u5BFE\u5FDC\u304C\u5FC5\u8981\u306A\u4F1A\u793E\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u64CD\u4F5C\u306F\u8868\u793A\u4E2D\u306E\u4F1A\u793E\u8B58\u5225\u5B50\u3067\u691C\u8A3C\u3055\u308C\u307E\u3059\u3002</div>
${opened ? detail : `<section id="company-grid" class="company-grid" aria-label="Company cards">${cards}</section>`}
<div id="screen-status" class="status" role="status">${escapeHtml(snapshot.statusText)}</div>
</main></body></html>`;
}
function parseColor(value, fallback) {
  const match = value.match(/^#([0-9a-f]{6})$/iu);
  if (!match) return fallback;
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
    255
  ];
}
function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const offset = (row * width + column) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}
function strokeRect(pixels, width, height, x, y, rectWidth, rectHeight, thickness, color) {
  fillRect(pixels, width, height, x, y, rectWidth, thickness, color);
  fillRect(pixels, width, height, x, y + rectHeight - thickness, rectWidth, thickness, color);
  fillRect(pixels, width, height, x, y, thickness, rectHeight, color);
  fillRect(pixels, width, height, x + rectWidth - thickness, y, thickness, rectHeight, color);
}
var GLYPHS = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};
function drawText(pixels, width, height, text, x, y, scale, color) {
  let cursor = Math.floor(x);
  for (const character of text.toUpperCase()) {
    const glyph = GLYPHS[character] ?? GLYPHS[" "];
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] === "1") fillRect(pixels, width, height, cursor + column * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}
function encodeScreenPng(snapshot) {
  const { width, height } = snapshot;
  const pixels = new Uint8Array(width * height * 4);
  fillRect(pixels, width, height, 0, 0, width, height, [246, 248, 252, 255]);
  fillRect(pixels, width, height, 0, 0, width, 76, [23, 32, 51, 255]);
  drawText(pixels, width, height, "BUSINESS DIRECTORY", 32, 18, 4, [255, 255, 255, 255]);
  drawText(pixels, width, height, "REVIEW QUEUE", 34, 52, 2, [191, 211, 238, 255]);
  const margin = 32;
  const gap = 18;
  const detailHeight = snapshot.openedCompanyId ? 170 : 0;
  const cardWidth = Math.floor((width - margin * 2 - gap) / 2);
  const cardHeight = snapshot.openedCompanyId ? 132 : Math.max(150, Math.floor((height - 76 - margin * 2 - gap - 34) / 2));
  snapshot.visibleCompanies.forEach((company, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = margin + column * (cardWidth + gap);
    const y = 96 + row * (cardHeight + gap);
    const cardFill = company.status === "opened" ? [236, 253, 245, 255] : [255, 255, 255, 255];
    fillRect(pixels, width, height, x, y, cardWidth, cardHeight, cardFill);
    const needsAttention = company.visualCue === "attention" && company.status !== "opened";
    const border = company.status === "opened" ? [22, 163, 74, 255] : needsAttention ? [220, 38, 38, 255] : parseColor(company.accent, [216, 224, 237, 255]);
    strokeRect(pixels, width, height, x, y, cardWidth, cardHeight, needsAttention ? 5 : 3, border);
    fillRect(pixels, width, height, x + 22, y + 20, 14, 14, parseColor(company.accent, [37, 99, 235, 255]));
    drawText(pixels, width, height, company.id, x + 46, y + 20, 2, [88, 101, 122, 255]);
    drawText(pixels, width, height, company.name, x + 22, y + 57, 4, [23, 32, 51, 255]);
    drawText(pixels, width, height, company.sector, x + 22, y + (snapshot.openedCompanyId ? 87 : 94), 2, [100, 116, 139, 255]);
    if (needsAttention) {
      fillRect(pixels, width, height, x + cardWidth - 122, y + 16, 98, 24, [220, 38, 38, 255]);
      drawText(pixels, width, height, "WARNING", x + cardWidth - 116, y + 22, 2, [255, 255, 255, 255]);
    }
    const statusColor = company.status === "opened" ? [22, 101, 52, 255] : [100, 116, 139, 255];
    drawText(pixels, width, height, company.status === "opened" ? "OPEN" : needsAttention ? "REVIEW" : "DONE", x + 22, y + cardHeight - 24, 2, statusColor);
  });
  if (snapshot.openedCompanyId) {
    const detailY = height - detailHeight - 26;
    fillRect(pixels, width, height, margin, detailY, width - margin * 2, detailHeight, [23, 32, 51, 255]);
    fillRect(pixels, width, height, margin, detailY, 8, detailHeight, [220, 38, 38, 255]);
    const opened = snapshot.visibleCompanies.find((company) => company.id === snapshot.openedCompanyId);
    drawText(pixels, width, height, "COMPANY DETAIL", margin + 26, detailY + 18, 2, [252, 165, 165, 255]);
    drawText(pixels, width, height, opened?.id ?? snapshot.openedCompanyId, margin + 26, detailY + 46, 3, [255, 255, 255, 255]);
    drawText(pixels, width, height, "DETAIL OPENED", margin + 26, detailY + 81, 2, [203, 213, 225, 255]);
    drawText(pixels, width, height, "NEEDS REVIEW", margin + 280, detailY + 81, 2, [254, 202, 202, 255]);
    drawText(pixels, width, height, "ATTACHMENT MISSING", margin + 280, detailY + 111, 2, [254, 202, 202, 255]);
  } else {
    fillRect(pixels, width, height, margin, height - 36, width - margin * 2, 2, [216, 224, 237, 255]);
    drawText(pixels, width, height, "STATE: READY", margin, height - 27, 2, [88, 101, 122, 255]);
  }
  return encodePngRgba(width, height, pixels);
}
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
  }
  return (crc ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload), 0);
  return new Uint8Array(Buffer.concat([length, payload, checksum]));
}
function encodePngRgba(width, height, pixels) {
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) {
    const source = row * width * 4;
    const target = row * (width * 4 + 1);
    rows[target] = 0;
    rows.set(pixels.subarray(source, source + width * 4), target + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Uint8Array(Buffer.concat([
    signature,
    Buffer.from(pngChunk("IHDR", ihdr)),
    Buffer.from(pngChunk("IDAT", new Uint8Array((0, import_node_zlib.deflateSync)(rows, { level: 9 })))),
    Buffer.from(pngChunk("IEND", new Uint8Array()))
  ]));
}

// test/computer-use-demo.ts
var ctx = { workspace: process.cwd(), restrictToWorkspace: true };
async function expectAsyncActionError(action, code) {
  await import_strict.default.rejects(action, (error) => error instanceof ComputerUseActionError && error.code === code);
}
function targetAndWrong(screen) {
  const target = screen.targetCompanyId;
  const wrong = screen.snapshot().visibleCompanies.find((company) => company.id !== target)?.id;
  import_strict.default.ok(wrong);
  return { target, wrong };
}
function hashBytes(bytes) {
  return (0, import_node_crypto2.createHash)("sha256").update(bytes).digest("hex");
}
async function testFixtureStateAndDeterminism() {
  const first = createSyntheticBusinessScreen({ seed: 53028, clock: () => "2026-08-28T00:00:00.000Z" });
  const second = createSyntheticBusinessScreen({ seed: 53028, clock: () => "2026-08-28T00:00:00.000Z" });
  const variants = Array.from({ length: 12 }, (_, offset) => createSyntheticBusinessScreen({ seed: 53029 + offset, clock: () => "2026-08-28T00:00:00.000Z" }));
  const firstSnapshot = first.snapshot();
  import_strict.default.equal(firstSnapshot.route, COMPUTER_USE_DEMO_ROUTE);
  import_strict.default.equal(firstSnapshot.revision, 0);
  import_strict.default.equal(firstSnapshot.openedCompanyId, null);
  import_strict.default.equal(firstSnapshot.visibleCompanies.filter((company) => company.visualCue === "attention").length, 1);
  import_strict.default.equal(firstSnapshot.visibleCompanies.filter((company) => company.status === "available").length, 4);
  import_strict.default.equal(first.targetCompanyId, firstSnapshot.visibleCompanies.find((company) => company.visualCue === "attention")?.id);
  import_strict.default.ok(!COMPUTER_USE_DEMO_PROMPT.includes(first.targetCompanyId));
  import_strict.default.ok(!COMPUTER_USE_DEMO_PROMPT.includes("B\u793E"));
  import_strict.default.equal(hashBytes(first.captureScreenshot().bytes), hashBytes(second.captureScreenshot().bytes), "same seed must render identical PNG bytes");
  const firstOrder = firstSnapshot.visibleCompanies.map((company) => company.id);
  import_strict.default.ok(variants.some((variant) => !variant.snapshot().visibleCompanies.map((company) => company.id).every((id, index) => id === firstOrder[index])), "seed range must produce a different card order");
  import_strict.default.equal(renderSyntheticBusinessScreen(first).route, COMPUTER_USE_DEMO_ROUTE);
}
async function testWrongTargetAndStalePrecondition() {
  const screen = createSyntheticBusinessScreen({ seed: 53028, clock: () => "2026-08-28T00:00:00.000Z" });
  const { wrong } = targetAndWrong(screen);
  const tool = createOpenCompanyTool(screen, screen.stateFingerprint());
  await expectAsyncActionError(() => tool.run({ company_id: wrong }, ctx), "wrong_target");
  import_strict.default.equal(screen.snapshot().openedCompanyId, null);
  const staleTool = createOpenCompanyTool(screen, screen.stateFingerprint());
  screen.openCompany(screen.targetCompanyId);
  await expectAsyncActionError(() => staleTool.run({ company_id: screen.targetCompanyId }, ctx), "stale_screen");
}
async function testActionDuplicateAndPostState() {
  const screen = createSyntheticBusinessScreen({ seed: 8, clock: () => "2026-08-28T00:00:00.000Z" });
  const { target } = targetAndWrong(screen);
  const before = screen.captureScreenshot();
  const tool = createOpenCompanyTool(screen, before.stateFingerprint);
  const output = await tool.run({ company_id: target }, ctx);
  import_strict.default.match(output, /open_company: succeeded/u);
  import_strict.default.match(output, /"changed":true/u);
  const after = screen.captureScreenshot();
  import_strict.default.equal(screen.snapshot().openedCompanyId, target);
  import_strict.default.equal(screen.snapshot().revision, 1);
  import_strict.default.notEqual(hashBytes(before.bytes), hashBytes(after.bytes), "state change must alter the screenshot");
  const duplicateTool = createOpenCompanyTool(screen, after.stateFingerprint);
  await expectAsyncActionError(() => duplicateTool.run({ company_id: target }, ctx), "duplicate_action");
  import_strict.default.equal(screen.snapshot().revision, 1);
}
async function testImageOnlyAdapterAndNegativeOmission() {
  const screen = createSyntheticBusinessScreen({ seed: 91, clock: () => "2026-08-28T00:00:00.000Z" });
  const provider = createScreenshotInputProvider(screen);
  const observation = await provider.capture();
  import_strict.default.equal(observation.mediaType, COMPUTER_USE_SCREEN_MEDIA_TYPE);
  import_strict.default.equal(observation.ephemeral, true);
  import_strict.default.equal(observation.stateFingerprint, screen.stateFingerprint());
  const image = toImageOnlyInput(observation);
  import_strict.default.deepEqual(Object.keys(image).sort(), ["bytes", "mediaType"]);
  import_strict.default.equal(image.mediaType, COMPUTER_USE_SCREEN_MEDIA_TYPE);
  import_strict.default.notEqual(image.bytes, observation.bytes, "adapter should not hand out the mutable observation buffer");
  import_strict.default.equal(image.bytes.length, observation.bytes.length);
  const serialized = JSON.stringify(image);
  import_strict.default.ok(!serialized.includes(screen.targetCompanyId));
  import_strict.default.ok(!serialized.includes(COMPUTER_USE_DEMO_ROUTE));
}
async function testLoopSequenceAndNormalExecutionSeam() {
  const screen = createSyntheticBusinessScreen({ seed: 53028, clock: () => "2026-08-28T00:00:00.000Z" });
  const phases = [];
  let decisionInput;
  let actionTool;
  let captureCount = 0;
  const provider = {
    capture: async () => {
      captureCount++;
      phases.push(captureCount === 1 ? "screenshot" : "post-screenshot");
      return screen.captureScreenshot();
    }
  };
  const result = await runComputerUseDemo({
    screen,
    screenshotProvider: provider,
    decideTarget: (image) => {
      phases.push("decision");
      decisionInput = image;
      import_strict.default.deepEqual(Object.keys(image).sort(), ["bytes", "mediaType"]);
      return { company_id: screen.targetCompanyId };
    },
    execute: async (call, tool) => {
      phases.push("execute");
      actionTool = tool;
      import_strict.default.equal(call.toolName, "open_company");
      return tool.run(call.input, ctx);
    },
    reobserve: (image) => {
      phases.push("reobserve");
      import_strict.default.deepEqual(Object.keys(image).sort(), ["bytes", "mediaType"]);
      return { visualStateConfirmed: true };
    }
  });
  import_strict.default.deepEqual(phases, ["screenshot", "decision", "execute", "post-screenshot", "reobserve"]);
  import_strict.default.ok(decisionInput);
  import_strict.default.equal(actionTool?.name, "open_company");
  import_strict.default.equal(screen.snapshot().openedCompanyId, screen.targetCompanyId);
  import_strict.default.equal(result.action.input.company_id, screen.targetCompanyId);
  import_strict.default.deepEqual(result.reobservation, { visualStateConfirmed: true });
  import_strict.default.equal(result.initialScreenshot.stateFingerprint !== result.postActionScreenshot.stateFingerprint, true);
}
async function testToolContractNoTargetLeak() {
  const screen = createSyntheticBusinessScreen({ seed: 53028 });
  const tool = createOpenCompanyTool(screen, screen.stateFingerprint());
  const schema = JSON.stringify(tool.parameters);
  import_strict.default.equal(tool.kind, "write");
  import_strict.default.equal(tool.requiresImage, true);
  import_strict.default.equal(tool.name, "open_company");
  import_strict.default.ok(!tool.description.includes(screen.targetCompanyId));
  import_strict.default.ok(!schema.includes(screen.targetCompanyId));
  import_strict.default.ok(!tool.description.includes("B\u793E"));
  import_strict.default.ok(!schema.includes("B\u793E"));
  import_strict.default.ok(!COMPUTER_USE_DEMO_PROMPT.includes("FOCUS"));
  import_strict.default.ok(!COMPUTER_USE_DEMO_PROMPT.includes("\u5B89\u5B9A ID"));
  await expectAsyncActionError(() => tool.run({ company_id: "unknown-id" }, ctx), "company_not_visible");
}
async function main() {
  await testFixtureStateAndDeterminism();
  await testWrongTargetAndStalePrecondition();
  await testActionDuplicateAndPostState();
  await testImageOnlyAdapterAndNegativeOmission();
  await testLoopSequenceAndNormalExecutionSeam();
  await testToolContractNoTargetLeak();
  console.log("computer-use-demo tests passed");
}
void main();
