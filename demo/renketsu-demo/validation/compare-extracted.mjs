import fs from 'node:fs'
import path from 'node:path'

const METRICS = ['revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees']

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

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

function asNonEmptyText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty`)
  return value.trim()
}

function asExactId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`${label} must be a non-empty exact string`)
  }
  return value
}

function normalizeText(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}_]+/gu, '')
}

function mapById(items, label) {
  const result = new Map()
  for (const item of items) {
    const id = asExactId(item?.id, `${label}[].id`)
    if (result.has(id)) fail(`${label} contains duplicate id ${id}`)
    result.set(id, item)
  }
  return result
}

function sameIdSet(actualMap, expectedMap, label) {
  const actualIds = [...actualMap.keys()].sort()
  const expectedIds = [...expectedMap.keys()].sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    fail(`${label} ids differ: actual=${actualIds.join(',')} expected=${expectedIds.join(',')}`)
  }
}

function issueSignature(issue) {
  return `${String(issue?.type ?? '')}\u0000${String(issue?.field ?? '')}`
}

function sortedIssueSignatures(issues, label) {
  return asArray(issues, label).map(issueSignature).sort()
}

function validateIssueMeaning(companyId, issue, index) {
  const label = `${companyId}.issues[${index}]`
  const message = asNonEmptyText(issue?.message, `${label}.message`)
  const normalizedMessage = normalizeText(message)
  if (issue.type === 'unit_variation') {
    if (/(?:no|not|isnot|thereisno|thereisnot|doesnothave|hasno|without)(?:a|an)?unit(?:variation|difference|issue)|unit(?:variation|difference|issue)(?:doesnotexist|notexist|isabsent|isnotpresent|ではない|なし|ありません)|単位(?:の)?(?:差異|差|違い)(?:は|が)?(?:ない|なし|ではない|ありません|ではありません)/u.test(normalizedMessage)) {
      fail(`${label}.message contradicts the issue classification`)
    }
  } else if (issue.type === 'account_variation') {
    if (/(?:no|not|isnot|thereisno|thereisnot|doesnothave|hasno|without)(?:a|an)?account(?:variation|difference|issue)|account(?:variation|difference|issue)(?:doesnotexist|notexist|isabsent|isnotpresent|ではない|なし|ありません)|科目(?:の)?(?:差異|差|違い)(?:は|が)?(?:ない|なし|ではない|ありません|ではありません)|notmapped|isnotmapped|対応しない|対応不可/u.test(normalizedMessage)) {
      fail(`${label}.message contradicts the account mapping`)
    }
  } else {
    fail(`${label}.type is unsupported: ${String(issue.type)}`)
  }
}

function compare(actual, expected) {
  const actualCompanies = mapById(asArray(actual?.companies, 'actual.companies'), 'actual.companies')
  const expectedCompanies = mapById(asArray(expected?.companies, 'expected.companies'), 'expected.companies')
  const actualMissing = mapById(asArray(actual?.missing, 'actual.missing'), 'actual.missing')
  const expectedMissing = mapById(asArray(expected?.missing, 'expected.missing'), 'expected.missing')

  sameIdSet(actualCompanies, expectedCompanies, 'submitted company')
  sameIdSet(actualMissing, expectedMissing, 'missing company')

  for (const id of actualCompanies.keys()) {
    if (actualMissing.has(id)) fail(`${id} cannot be both submitted and missing`)
  }

  let quoteCount = 0
  let issueCount = 0
  const issueTypes = {}

  for (const [id, expectedCompany] of expectedCompanies) {
    const actualCompany = actualCompanies.get(id)
    for (const metric of METRICS) {
      const actualValue = actualCompany?.values?.[metric]
      const expectedValue = expectedCompany?.values?.[metric]
      if (typeof actualValue !== 'number' || !Number.isFinite(actualValue) || actualValue !== expectedValue) {
        fail(`${id}.values.${metric} differs: actual=${String(actualValue)} expected=${String(expectedValue)}`)
      }
    }

    const actualQuotes = asArray(actualCompany?.quotes, `${id}.quotes`)
    const expectedQuotes = asArray(expectedCompany?.quotes, `expected.${id}.quotes`)
    if (actualQuotes.length !== expectedQuotes.length) {
      fail(`${id}.quotes count differs: actual=${actualQuotes.length} expected=${expectedQuotes.length}`)
    }
    quoteCount += actualQuotes.length

    const actualIssues = asArray(actualCompany?.issues, `${id}.issues`)
    const expectedIssues = asArray(expectedCompany?.issues, `expected.${id}.issues`)
    const actualSignatures = sortedIssueSignatures(actualIssues, `${id}.issues`)
    const expectedSignatures = sortedIssueSignatures(expectedIssues, `expected.${id}.issues`)
    if (JSON.stringify(actualSignatures) !== JSON.stringify(expectedSignatures)) {
      fail(`${id}.issues classification differs`)
    }
    actualIssues.forEach((issue, index) => {
      validateIssueMeaning(id, issue, index)
      issueCount += 1
      issueTypes[issue.type] = (issueTypes[issue.type] ?? 0) + 1
    })
  }

  for (const [id, expectedItem] of expectedMissing) {
    const actualItem = actualMissing.get(id)
    if (actualItem?.type !== expectedItem?.type || actualItem?.type !== 'unsubmitted') {
      fail(`${id}.type must exactly match unsubmitted classification`)
    }
  }
  const expectedQuoteCount = [...expectedCompanies.values()].reduce((sum, company) => sum + asArray(company.quotes, `expected.${company.id}.quotes`).length, 0)
  const expectedIssueCount = [...expectedCompanies.values()].reduce((sum, company) => sum + asArray(company.issues, `expected.${company.id}.issues`).length, 0)
  if (quoteCount !== expectedQuoteCount) fail(`quotes count differs: actual=${quoteCount} expected=${expectedQuoteCount}`)
  if (issueCount !== expectedIssueCount) fail(`issues count differs: actual=${issueCount} expected=${expectedIssueCount}`)

  return {
    ok: true,
    strict: {
      companies: actualCompanies.size,
      missing: actualMissing.size,
      quotes: quoteCount,
      issues: issueCount,
      issueTypes,
      metricsPerCompany: METRICS.length,
    },
    semantic: {
      issueMessages: issueCount,
      missingQuotes: actualMissing.size,
    },
  }
}

const [actualArg, expectedArg] = process.argv.slice(2)
if (!actualArg || !expectedArg) fail('usage: node compare-extracted.mjs <actual.json> <expected.json>')

const actualPath = path.resolve(actualArg)
const expectedPath = path.resolve(expectedArg)
process.stdout.write(`${JSON.stringify(compare(readJson(actualPath), readJson(expectedPath)))}\n`)
