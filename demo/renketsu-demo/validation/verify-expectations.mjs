#!/usr/bin/env node
/**
 * Independent deterministic verifier for the demo fixtures.
 *
 * It intentionally re-implements unit/rate conversion instead of importing or
 * evaluating the PowerShell generator. The input contract is rates CSV plus
 * extracted.correct.json and expected.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/+/, '').replace(/^([A-Za-z]):/, '$1:'));
// URL pathname escaping differs on Windows; resolve from the process cwd when
// called as documented (`node validation/verify-expectations.mjs`).
const demoRoot = path.resolve(process.cwd(), 'demo', 'renketsu-demo');
const workspace = path.join(demoRoot, 'workspace');
const validation = path.join(demoRoot, 'validation');
const allowMissingXlsx = process.argv.includes('--allow-missing-xlsx');

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readRates(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/);
  if (lines.shift() !== 'Currency,JPYPerUnit') fail('unexpected rate header');
  const rates = {};
  for (const line of lines) {
    const [currency, value] = line.split(',');
    if (!currency || !Number.isFinite(Number(value))) fail(`bad rate row: ${line}`);
    rates[currency] = Number(value);
  }
  return rates;
}

function nearlyEqual(actual, expected, label) {
  if (!Number.isFinite(Number(actual)) || Math.abs(Number(actual) - Number(expected)) > 1e-6) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

const rates = readRates(path.join(workspace, 'rates', 'レート表.csv'));
for (const currency of ['JPY', 'USD', 'EUR', 'CNY', 'THB', 'GBP']) {
  if (!(currency in rates)) fail(`missing rate ${currency}`);
}
const extracted = readJson(path.join(validation, 'extracted.correct.json'));
const expected = readJson(path.join(validation, 'expected.json'));
const expectedIds = [...Array.from({ length: 4 }, (_, i) => `JP0${i + 1}`), ...Array.from({ length: 16 }, (_, i) => `OS${String(i + 1).padStart(2, '0')}`)];
const submittedIds = extracted.companies.map((company) => company.id);
if (extracted.companies.length !== 19) fail(`submitted company count ${extracted.companies.length}`);
if (extracted.missing.length !== 1 || extracted.missing[0].id !== 'OS16') fail('missing company contract is not exactly OS16');
if (new Set(submittedIds).size !== submittedIds.length) fail('duplicate submitted company id');
if (submittedIds.includes('OS16')) fail('OS16 unexpectedly submitted');
const expectedSubmittedIds = expectedIds.filter((id) => id !== 'OS16');
if (submittedIds.length !== expectedSubmittedIds.length || expectedSubmittedIds.some((id) => !submittedIds.includes(id))) {
  fail(`submitted id set mismatch: ${submittedIds.join(',')}`);
}
if (expected.companies.length !== 19) fail(`expected company count ${expected.companies.length}`);

const expectedById = new Map(expected.companies.map((company) => [company.id, company]));
const fields = ['revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees'];
const moneyFields = fields.slice(0, 4);
const unitFactors = { ones: 1, thousands: 1000, millions: 1000000 };
let issueUnitCount = 0;
let issueAccountCount = 0;
const currencies = new Set();
const extensionCounts = { '.csv': 0, '.txt': 0, '.xlsx': 0 };

for (const company of extracted.companies) {
  if (!expectedIds.includes(company.id)) fail(`unexpected company id ${company.id}`);
  const target = expectedById.get(company.id);
  if (!target) fail(`missing expected row for ${company.id}`);
  currencies.add(company.currency);
  if (!(company.unit in unitFactors)) fail(`${company.id}: unknown unit ${company.unit}`);
  if (!(company.currency in rates)) fail(`${company.id}: unknown currency ${company.currency}`);
  const relativeSource = company.source.replace(/^reports[\\/]/, '');
  const sourceFile = path.join(workspace, 'reports', relativeSource);
  if (!fs.existsSync(sourceFile)) {
    if (allowMissingXlsx && path.extname(sourceFile).toLowerCase() === '.xlsx') continue;
    fail(`${company.id}: source file missing ${sourceFile}`);
  }
  const extension = path.extname(sourceFile).toLowerCase();
  if (extension in extensionCounts) extensionCounts[extension] += 1;
  else fail(`${company.id}: unsupported source extension ${extension}`);

  const expectedValues = target.expectedLedgerValues ?? target.normalizedMillionJPY ?? target.values;
  for (const field of fields) {
    const sourceValue = Number(company.values[field]);
    if (!Number.isFinite(sourceValue)) fail(`${company.id}: bad source value ${field}`);
    const calculated = field === 'employees'
      ? sourceValue
      : sourceValue * unitFactors[company.unit] * rates[company.currency] / 1_000_000;
    nearlyEqual(calculated, expectedValues[field], `${company.id}.${field}`);
  }
  if (target.id !== company.id || target.source !== company.source) fail(`${company.id}: source identity mismatch`);

  for (const quote of company.quotes) {
    if (!fields.includes(quote.field) || typeof quote.quote !== 'string' || quote.quote.length === 0) {
      fail(`${company.id}: malformed quote`);
    }
    // CSV/TXT can be checked byte-for-byte after decoding. XLSX values are
    // represented as cells; the structural check above plus non-empty quote is
    // the deterministic check available without a third-party ZIP parser.
    if (extension === '.csv' || extension === '.txt') {
      const bytes = fs.readFileSync(sourceFile);
      let sourceText;
      try {
        sourceText = extension === '.csv' && company.id === 'JP04'
          ? new TextDecoder('shift_jis').decode(bytes)
          : new TextDecoder('utf-8').decode(bytes);
      } catch {
        sourceText = bytes.toString('utf8');
      }
      if (!sourceText.includes(quote.quote)) fail(`${company.id}: quote is not an exact source substring: ${quote.quote}`);
    }
  }
  for (const issue of company.issues) {
    if (issue.type === 'unit_variation') issueUnitCount += 1;
    if (issue.type === 'account_variation') issueAccountCount += 1;
    if (!fields.includes(issue.field) || typeof issue.quote !== 'string' || issue.quote.length === 0) {
      fail(`${company.id}: malformed issue`);
    }
  }
}

if (currencies.size !== 6 || !['JPY', 'USD', 'EUR', 'CNY', 'THB', 'GBP'].every((currency) => currencies.has(currency))) {
  fail(`currency mix is ${Array.from(currencies).join(',')}`);
}
if (issueUnitCount < 1 || issueAccountCount !== 1) fail(`issue counts unit=${issueUnitCount}, account=${issueAccountCount}`);
if (!allowMissingXlsx && extensionCounts['.xlsx'] < 3) fail(`xlsx source count ${extensionCounts['.xlsx']}`);
if (extensionCounts['.csv'] < 1 || extensionCounts['.txt'] < 1) fail('CSV/TXT source variation missing');

const sums = Object.fromEntries(fields.map((field) => [field, 0]));
for (const company of expected.companies) {
  const values = company.expectedLedgerValues ?? company.normalizedMillionJPY ?? company.values;
  for (const field of fields) sums[field] += Number(values[field]);
}
for (const field of fields) nearlyEqual(sums[field], expected.grandTotals[field], `grandTotals.${field}`);

console.log(JSON.stringify({
  status: 'ok',
  submitted: extracted.companies.length,
  missing: extracted.missing.map((company) => company.id),
  domestic: extracted.companies.filter((company) => company.id.startsWith('JP')).length,
  overseas: extracted.companies.filter((company) => company.id.startsWith('OS')).length,
  currencies: Array.from(currencies).sort(),
  extensions: extensionCounts,
  issues: { unit_variation: issueUnitCount, account_variation: issueAccountCount },
  grandTotals: expected.grandTotals,
}, null, 2));
