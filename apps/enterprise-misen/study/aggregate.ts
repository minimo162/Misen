import type { FailureTaxonomy, PaidAttemptReservation, StudyCheckpoint, StudyMonth, StudyRunRecord } from './schema.js'

export function wilson95(pass: number, total: number): { low: number; high: number } | null {
  if (total === 0) return null
  const z = 1.959963984540054, p = pass / total, z2 = z * z
  const center = (p + z2 / (2 * total)) / (1 + z2 / total)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / (1 + z2 / total)
  return { low: center - margin, high: center + margin }
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * p
  const lower = Math.floor(position), upper = Math.ceil(position), weight = position - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

function distribution(values: readonly number[]) {
  return { count: values.length, min: percentile(values, 0), median: percentile(values, 0.5), max: percentile(values, 1), p90: percentile(values, 0.9), p95: percentile(values, 0.95) }
}

function reliability(records: readonly StudyRunRecord[], month?: StudyMonth) {
  const valid = records.filter(record => record.status !== 'INVALID' && (month === undefined || record.month === month))
  const pass = valid.filter(record => record.status === 'PASS').length
  return { pass, fail: valid.length - pass, total: valid.length, wilson95: wilson95(pass, valid.length) }
}

export function aggregateStudy(records: readonly StudyRunRecord[], checkpoint: StudyCheckpoint, reservations: readonly PaidAttemptReservation[]) {
  const ordered = [...records].sort((a, b) => a.paidAttemptNumber - b.paidAttemptNumber)
  for (const record of ordered) {
    if (record.studyId !== checkpoint.studyId || record.productionBaselineSha !== checkpoint.productionBaselineSha || record.observerSha !== checkpoint.observerSha || JSON.stringify(record.configuration) !== JSON.stringify(checkpoint.configuration)) throw new Error('mixed study provenance rejected')
    const reservation = reservations.find(item => item.paidAttemptNumber === record.paidAttemptNumber)
    if (!reservation || reservation.studyRunNumber !== record.studyRunNumber || reservation.month !== record.month) throw new Error('record/reservation mismatch')
  }
  const valid = ordered.filter(record => record.status !== 'INVALID')
  const taxonomy = Object.fromEntries([...new Set(ordered.map(record => record.failureTaxonomy).filter(Boolean) as FailureTaxonomy[])].sort().map(key => [key, ordered.filter(record => record.failureTaxonomy === key).length]))
  const patternCounts = new Map<string, number>()
  for (const record of valid.filter(item => item.status === 'FAIL')) {
    const failedAxes = record.axisMatrix ? Object.entries(record.axisMatrix).filter(([, result]) => result.status === 'FAIL').map(([axis]) => axis).sort() : []
    const signature = `${record.failureTaxonomy ?? 'UNCLASSIFIED'}:${failedAxes.join('+') || 'NO_AXIS'}`
    patternCounts.set(signature, (patternCounts.get(signature) ?? 0) + 1)
  }
  const toolCalls = valid.map(record => record.toolStarts.length)
  const knownCorrections = valid.filter(record => record.selfCorrectionCount !== null)
  return {
    schemaVersion: 1,
    studyId: ordered[0]?.studyId ?? null,
    productionBaselineSha: ordered[0]?.productionBaselineSha ?? null,
    observerSha: ordered[0]?.observerSha ?? null,
    reliability: { july: reliability(ordered, '7月'), august: reliability(ordered, '8月'), combined: reliability(ordered) },
    performance: {
      elapsedMs: distribution(valid.map(record => record.elapsedMs)),
      requests: distribution(valid.map(record => record.requestCount)),
      toolCalls: distribution(toolCalls),
      rssBytes: distribution(valid.map(record => record.rssBytes)),
    },
    behavior: {
      toolErrors: valid.reduce((sum, record) => sum + record.toolErrorCount, 0),
      toolCalls: toolCalls.reduce((sum, value) => sum + value, 0),
      toolErrorFrequency: toolCalls.reduce((sum, value) => sum + value, 0) === 0 ? null : valid.reduce((sum, record) => sum + record.toolErrorCount, 0) / toolCalls.reduce((sum, value) => sum + value, 0),
      selfCorrectionAvailableRuns: knownCorrections.length,
      selfCorrections: knownCorrections.reduce((sum, record) => sum + (record.selfCorrectionCount ?? 0), 0),
      selfCorrectionFrequency: valid.reduce((sum, record) => sum + record.toolValidationErrorCount, 0) === 0 ? null : knownCorrections.reduce((sum, record) => sum + (record.selfCorrectionCount ?? 0), 0) / valid.reduce((sum, record) => sum + record.toolValidationErrorCount, 0),
      failureTaxonomy: taxonomy,
      repeatedFailurePatterns: [...patternCounts].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1]).map(([signature, count]) => ({ signature, count })),
    },
    integrity: {
      inputMutationIncidents: ordered.filter(record => record.integrity.inputMutation).length,
      forbiddenCapabilityIncidents: ordered.filter(record => record.integrity.forbiddenCapability).length,
      credentialExposureIncidents: ordered.filter(record => record.integrity.credentialExposure === true).length,
      unexpectedNetworkIncidents: ordered.filter(record => record.integrity.unexpectedNetwork === true).length,
      networkObservationUnavailableRuns: ordered.filter(record => record.integrity.unexpectedNetwork === null).length,
    },
    budget: {
      paidAttemptsReserved: reservations.length,
      paidAttemptsWithRecords: ordered.length,
      catalogEstimatedCostUsd: Number(ordered.reduce((sum, record) => sum + (record.usage.catalogEstimatedCostUsd ?? 0), 0).toFixed(12)),
      recordsWithoutCatalogCostEstimate: ordered.filter(record => record.usage.catalogEstimatedCostUsd === null).length,
    },
    invalidAttempts: ordered.filter(record => record.status === 'INVALID').map(record => ({ paidAttemptNumber: record.paidAttemptNumber, reason: record.invalidReason })),
  }
}
