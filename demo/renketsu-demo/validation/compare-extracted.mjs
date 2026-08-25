import fs from 'node:fs'
import path from 'node:path'

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exit(1)
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''))
  } catch (error) {
    fail(`cannot read JSON ${filePath}: ${error.message}`)
  }
}

function arraySortKey(parentKey, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value)
  if (parentKey === 'companies' || parentKey === 'missing') return String(value.id ?? '')
  if (parentKey === 'quotes') return `${String(value.field ?? '')}\u0000${String(value.quote ?? '')}`
  if (parentKey === 'issues') return `${String(value.type ?? '')}\u0000${String(value.field ?? '')}\u0000${String(value.quote ?? '')}`
  return JSON.stringify(value)
}

function canonicalize(value, parentKey = '') {
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalize(entry, parentKey))
    if (['companies', 'missing', 'quotes', 'issues'].includes(parentKey)) {
      items.sort((left, right) => arraySortKey(parentKey, left).localeCompare(arraySortKey(parentKey, right)))
    }
    return items
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], key)]))
}

const [actualArg, expectedArg] = process.argv.slice(2)
if (!actualArg || !expectedArg) fail('usage: node compare-extracted.mjs <actual.json> <expected.json>')

const actualPath = path.resolve(actualArg)
const expectedPath = path.resolve(expectedArg)
const actual = JSON.stringify(canonicalize(readJson(actualPath)))
const expected = JSON.stringify(canonicalize(readJson(expectedPath)))
if (actual !== expected) fail('actual extraction does not exactly match extracted.correct.json')

process.stdout.write(`${JSON.stringify({ ok: true, companies: JSON.parse(actual).companies.length })}\n`)
