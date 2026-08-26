import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const comparator = path.resolve(import.meta.dirname, 'compare-extracted.mjs')
const expectedPath = path.resolve(import.meta.dirname, 'extracted.correct.json')
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8').replace(/^\uFEFF/u, ''))
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'renketsu-compare-'))

function run(actual, expectedFixture = expected) {
  const actualPath = path.join(temporaryDirectory, 'actual.json')
  const comparisonPath = path.join(temporaryDirectory, 'expected.json')
  fs.writeFileSync(actualPath, JSON.stringify(actual))
  fs.writeFileSync(comparisonPath, JSON.stringify(expectedFixture))
  return spawnSync(process.execPath, [comparator, actualPath, comparisonPath], { encoding: 'utf8' })
}

function clone(value) {
  return structuredClone(value)
}

try {
  const natural = clone(expected)
  for (const company of natural.companies) {
    for (const issue of company.issues) {
      issue.message = issue.type === 'unit_variation'
        ? company.id
        : issue.field
    }
  }
  natural.missing[0].quote = 'OS16 提出ファイルなし'
  const pass = run(natural)
  assert.equal(pass.status, 0, pass.stderr)
  const result = JSON.parse(pass.stdout)
  assert.deepEqual(result.strict, {
    companies: 19,
    missing: 1,
    quotes: 95,
    issues: 4,
    issueTypes: { unit_variation: 3, account_variation: 1 },
    metricsPerCompany: 5,
  })
  assert.deepEqual(result.semantic, { issueMessages: 4, missingQuotes: 1 })

  const wrongValue = clone(natural)
  wrongValue.companies[0].values.revenue += 1
  assert.notEqual(run(wrongValue).status, 0, 'numeric differences must fail')

  const wrongClassification = clone(natural)
  wrongClassification.companies.find((company) => company.id === 'OS02').issues[0].type = 'account_variation'
  assert.notEqual(run(wrongClassification).status, 0, 'issue classification differences must fail')

  const wrongQuoteCount = clone(natural)
  wrongQuoteCount.companies[0].quotes.pop()
  assert.notEqual(run(wrongQuoteCount).status, 0, 'quote count differences must fail')

  const contradictoryIssue = clone(natural)
  contradictoryIssue.companies.find((company) => company.id === 'OS02').issues[0].message = 'OS02 revenue has no unit difference; unit variation'
  assert.notEqual(run(contradictoryIssue).status, 0, 'contradictory issue text must fail')

  const contradictoryMissing = clone(natural)
  contradictoryMissing.missing[0].quote = 'OS16 submitted; no file needed'
  assert.notEqual(run(contradictoryMissing).status, 0, 'contradictory missing text must fail')

  const missingIssueTarget = clone(natural)
  missingIssueTarget.companies.find((company) => company.id === 'OS02').issues[0].message = 'unit variation'
  assert.notEqual(run(missingIssueTarget).status, 0, 'issue message without a target must fail')

  const missingCompanyTarget = clone(natural)
  missingCompanyTarget.missing[0].quote = '提出ファイルなし'
  assert.notEqual(run(missingCompanyTarget).status, 0, 'missing quote without a target must fail')

  const companyNameOnly = clone(natural)
  companyNameOnly.missing[0].quote = '架空OS子会社16 提出ファイルなし'
  assert.notEqual(run(companyNameOnly).status, 0, 'missing quote with company name but no ID must fail')

  const wrongEvidence = clone(natural)
  wrongEvidence.companies.find((company) => company.id === 'OS02').issues[0].quote = ''
  assert.equal(run(wrongEvidence).status, 0, 'issue quote prose is not an exact-match acceptance field')

  const wrongId = clone(natural)
  wrongId.companies.find((company) => company.id === 'OS02').id = ' OS02 '
  assert.notEqual(run(wrongId).status, 0, 'whitespace-altered company ID must fail')

  const truthfulIssueNegation = clone(natural)
  truthfulIssueNegation.companies.find((company) => company.id === 'OS02').issues[0].message = 'OS02 revenue は正常ではなく千単位の差異なので補正する'
  assert.equal(run(truthfulIssueNegation).status, 0, 'truthful issue negation must pass')

  const truthfulMissingNegation = clone(natural)
  truthfulMissingNegation.missing[0].quote = 'OS16 は提出済みではなく未提出'
  assert.equal(run(truthfulMissingNegation).status, 0, 'truthful missing negation must pass')

  const misleadingMissing = clone(natural)
  misleadingMissing.missing[0].quote = 'OS16 は昨日提出したが現在ファイルなし'
  assert.notEqual(run(misleadingMissing).status, 0, 'submitted-but-missing prose must fail')

  const negatedUnit = clone(natural)
  negatedUnit.companies.find((company) => company.id === 'OS02').issues[0].message = 'OS02 revenue is not thousand; unit variation'
  assert.equal(run(negatedUnit).status, 0, 'optional unit details are outside the strict acceptance layer')

  const negatedMapping = clone(natural)
  negatedMapping.companies.find((company) => company.id === 'OS06').issues[0].message = 'OS06 operatingProfit: Operating result is not mapped; account variation'
  assert.notEqual(run(negatedMapping).status, 0, 'negated account mapping must fail')

  const truthfulConversion = clone(natural)
  truthfulConversion.companies.find((company) => company.id === 'OS02').issues[0].message = 'OS02 revenue: 千単位を百万円単位に換算'
  assert.equal(run(truthfulConversion).status, 0, 'truthful conversion details must pass')

  const partialIssueId = clone(natural)
  partialIssueId.companies.find((company) => company.id === 'OS02').issues[0].message = 'OS020'
  assert.notEqual(run(partialIssueId).status, 0, 'partial company ID must not identify an issue target')

  const partialMissingId = clone(natural)
  partialMissingId.missing[0].quote = 'OS160'
  assert.notEqual(run(partialMissingId).status, 0, 'partial company ID must not identify a missing target')

  const completedSubmission = clone(natural)
  completedSubmission.missing[0].quote = 'OS16 提出完了、ファイルなし'
  assert.notEqual(run(completedSubmission).status, 0, 'completed-submission prose must fail')

  process.stdout.write('compare-extracted: ALL PASS\n')
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
