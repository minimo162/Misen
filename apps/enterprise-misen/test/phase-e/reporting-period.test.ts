import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  deriveSourceReportingPeriod,
  deriveUniqueReportingPeriod,
  reportingPeriodMatches,
} from '../../acceptance/live-brain.js'
import { createEnterpriseFixtureWorkspace } from '../../demo/enterprise-excel/fixtures.js'

const JULY_2024 = Object.freeze({ year: 2024, month: 7 })
const AUGUST_2024 = Object.freeze({ year: 2024, month: 8 })

test('Decision 429 accepts only the authorized July reporting-period representations', () => {
  for (const value of ['7月', '2024年7月']) assert.equal(reportingPeriodMatches(value, JULY_2024), true, value)
  for (const value of [
    '8月',
    '2024年8月',
    '2023年7月',
    '',
    'unparseable',
    'July',
    'Jul',
    '2024-07',
    '2024/07',
    '7',
    '07',
    'report 7月',
    '2024年7月 report',
  ]) assert.equal(reportingPeriodMatches(value, JULY_2024), false, value)
})

test('Decision 429 accepts only the authorized August reporting-period representations', () => {
  for (const value of ['8月', '2024年8月']) assert.equal(reportingPeriodMatches(value, AUGUST_2024), true, value)
  for (const value of ['7月', '2024年7月', '2023年8月']) {
    assert.equal(reportingPeriodMatches(value, AUGUST_2024), false, value)
  }
})

test('Decision 429 derives one concrete period only when all source workbooks agree', () => {
  assert.deepEqual(deriveUniqueReportingPeriod([
    new Date('2024-07-31T00:00:00.000Z'),
    new Date('2024-07-31T00:00:00.000Z'),
    new Date('2024-07-31T00:00:00.000Z'),
  ]), JULY_2024)

  assert.throws(() => deriveUniqueReportingPeriod([
    new Date('2024-07-31T00:00:00.000Z'),
    new Date('2024-08-31T00:00:00.000Z'),
    new Date('2024-07-31T00:00:00.000Z'),
  ]), /source reporting periods are inconsistent/u)

  assert.throws(() => deriveUniqueReportingPeriod([
    new Date('2024-07-31T00:00:00.000Z'),
    new Date('2023-07-31T00:00:00.000Z'),
    new Date('2024-07-31T00:00:00.000Z'),
  ]), /source reporting periods are inconsistent/u)
})

test('Decision 429 rejects missing or invalid source reporting dates', () => {
  assert.throws(() => deriveUniqueReportingPeriod([]), /source reporting period is missing/u)
  assert.throws(() => deriveUniqueReportingPeriod([
    new Date('2024-07-31T00:00:00.000Z'),
    '2024-07-31',
    new Date('2024-07-31T00:00:00.000Z'),
  ]), /source reporting period is not a valid date/u)
})

test('Decision 429 derives July and August from the actual source workbook As of cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-period-acceptance-'))
  try {
    await createEnterpriseFixtureWorkspace(root)
    assert.deepEqual(await deriveSourceReportingPeriod(root, '7月'), JULY_2024)
    assert.deepEqual(await deriveSourceReportingPeriod(root, '8月'), AUGUST_2024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
