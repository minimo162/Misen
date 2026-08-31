import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  deriveSourceTriples,
  rowTriplesMatchAsSet,
  type CompanyValueTriple,
} from '../../acceptance/live-brain.js'
import { createEnterpriseFixtureWorkspace } from '../../demo/enterprise-excel/fixtures.js'

const EXPECTED_JULY: readonly CompanyValueTriple[] = Object.freeze([
  ['Alpha', 1200, 700],
  ['Beta', 950, 500],
  ['Gamma', 1100, 650],
])

test('Decision 430 derives expected triples from the actual July source workbooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-rows-diagnostic-'))
  try {
    await createEnterpriseFixtureWorkspace(root)
    assert.deepEqual(await deriveSourceTriples(root, '7月'), EXPECTED_JULY)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Decision 430 diagnostic set comparison distinguishes order from association/value errors', () => {
  assert.equal(rowTriplesMatchAsSet([
    ['Gamma', 1100, 650],
    ['Beta', 950, 500],
    ['Alpha', 1200, 700],
  ], EXPECTED_JULY), true)

  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', 1100, 650],
    ['Beta', 950, 500],
    ['Gamma', 1200, 700],
  ], EXPECTED_JULY), false)

  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', 1201, 700],
    ['Beta', 950, 500],
    ['Gamma', 1100, 650],
  ], EXPECTED_JULY), false)
})

test('Decision 430 diagnostic set comparison rejects missing, duplicate, unknown, and malformed rows', () => {
  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', 1200, 700],
    ['Beta', 950, 500],
  ], EXPECTED_JULY), false)

  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', 1200, 700],
    ['Alpha', 1200, 700],
    ['Gamma', 1100, 650],
  ], EXPECTED_JULY), false)

  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', 1200, 700],
    ['Beta', 950, 500],
    ['Unknown', 1100, 650],
  ], EXPECTED_JULY), false)

  assert.equal(rowTriplesMatchAsSet([
    ['Alpha', '1200', 700],
    ['Beta', 950, 500],
    ['Gamma', 1100, 650],
  ], EXPECTED_JULY), false)
})
