import fs from 'node:fs'
import path from 'node:path'

const METRICS = ['revenue', 'operatingProfit', 'netIncome', 'totalAssets', 'employees']
const FIELD_TERMS = {
  revenue: ['revenue', 'sales', '売上高', '売上'],
  operatingProfit: ['operatingprofit', 'operatingresult', '営業利益', '営業損益'],
  netIncome: ['netincome', '当期純利益', '純利益'],
  totalAssets: ['totalassets', '総資産'],
  employees: ['employees', 'employee', '従業員数', '従業員'],
}

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

function containsAny(normalizedText, terms) {
  return terms.some((term) => normalizedText.includes(normalizeText(term)))
}

function containsExactToken(text, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(String(text).normalize('NFKC'))
}

function messageIdentifiesTarget(message, companyId, field) {
  if (containsExactToken(message, companyId) || containsExactToken(message, field)) return true
  return (FIELD_TERMS[field] ?? []).some((term) => {
    return /^[\x00-\x7F]+$/u.test(term) ? containsExactToken(message, term) : String(message).normalize('NFKC').includes(term)
  })
}

function validateIssueMeaning(companyId, issue, index) {
  const label = `${companyId}.issues[${index}]`
  const message = asNonEmptyText(issue?.message, `${label}.message`)
  const normalizedMessage = normalizeText(message)
  const field = String(issue?.field ?? '')

  if (!messageIdentifiesTarget(message, companyId, field)) fail(`${label}.message does not identify ${companyId} or ${field}`)

  const mentionedCompanyIds = message.match(/(?:JP|OS)\d{2}/giu) ?? []
  if (mentionedCompanyIds.some((id) => id.toUpperCase() !== companyId.toUpperCase())) {
    fail(`${label}.message mentions a different company`)
  }
  if (issue.type === 'unit_variation') {
    if (/(nounitvariation|nounitdifference|nounitissue|notunitvariation|notunitdifference|unitvariationではない|unitvariationなし|単位差(?:異|違い)?(?:は)?(?:ない|なし|ではない)|単位違い(?:は)?(?:ない|なし|ではない))/u.test(normalizedMessage)) {
      fail(`${label}.message contradicts the issue classification`)
    }
  } else if (issue.type === 'account_variation') {
    if (/(noaccountvariation|noaccountdifference|noaccountissue|notaccountvariation|notaccountdifference|accountvariationではない|accountvariationなし|科目差(?:異|違い)?(?:は)?(?:ない|なし|ではない)|notmapped|isnotmapped|対応しない|対応不可)/u.test(normalizedMessage)) {
      fail(`${label}.message contradicts the account mapping`)
    }
  } else {
    fail(`${label}.type is unsupported: ${String(issue.type)}`)
  }
}

function validateMissingMeaning(item, expectedItem, index) {
  const label = `missing[${index}]`
  const quote = asNonEmptyText(item?.quote, `${label}.quote`)
  const normalized = normalizeText(quote)
  const id = asExactId(item?.id, `${label}.id`)
  if (!containsExactToken(quote, id)) {
    fail(`${label}.quote does not identify ${id}`)
  }
  const japaneseSubmitted = /(提出済|提出完了|提出した|提出あり|受領済|受領した|ファイルあり)/u.test(normalized)
  const japaneseNegated = /(提出済み?ではなく|提出完了ではなく|提出した(?:わけ)?ではなく|受領済み?ではなく|受領した(?:わけ)?ではなく)/u.test(normalized)
  if (japaneseSubmitted && !japaneseNegated) {
    fail(`${label}.quote contradicts the unsubmitted classification`)
  }
  if (normalized.includes('submitted') && !normalized.includes('notsubmitted') && !normalized.includes('unsubmitted')) {
    fail(`${label}.quote contradicts the unsubmitted classification`)
  }
  const mentionedCompanyIds = quote.match(/(?:JP|OS)\d{2}/giu) ?? []
  if (mentionedCompanyIds.some((mentionedId) => mentionedId.toUpperCase() !== id.toUpperCase())) {
    fail(`${label}.quote mentions a different company`)
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
  ;[...actualMissing.values()].forEach((item, index) => validateMissingMeaning(item, expectedMissing.get(item.id), index))

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
