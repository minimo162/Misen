import test from 'node:test'
import { strict as assert } from 'node:assert'
import { additionalOperationStep, createStoredPlan, matchingPendingStep, parsePlanProposal } from '../src/web/planning.js'

test('model plan validation accepts one bounded read step and rejects unsafe or invented fields', () => {
  const proposal = parsePlanProposal({ steps: [{ title: 'Alpha.xlsxの売上を確認', tool: 'spreadsheet_read', target: 'input/Alpha.xlsx' }] })
  assert.deepEqual(proposal?.steps[0], { title: 'Alpha.xlsxの売上を確認', tool: 'spreadsheet_read', target: 'input/Alpha.xlsx' })
  assert.equal(createStoredPlan('read-1', proposal).visible, false)
  assert.equal(createStoredPlan('write-1', parsePlanProposal({ steps: [{ title: '月次レポートを作成', tool: 'office_create_output', target: 'output/report.xlsx' }] })).visible, true)
  assert.equal(parsePlanProposal({ steps: [{ title: 'a'.repeat(31), tool: 'spreadsheet_read', target: 'input/a.xlsx' }] }), undefined)
  assert.equal(parsePlanProposal({ steps: [{ title: '読む', tool: 'run_code', target: 'input/a.xlsx' }] }), undefined)
  assert.equal(parsePlanProposal({ steps: [{ title: '読む', tool: 'spreadsheet_read', target: '../outside.xlsx' }] }), undefined)
})

test('Tool matching requires both Tool and target; unmatched calls become additional operations', () => {
  const plan = createStoredPlan('write-2', parsePlanProposal({ steps: [
    { title: 'テンプレートを確認', tool: 'spreadsheet_read', target: 'input/template.xlsx' },
    { title: 'レポートを作成', tool: 'office_create_output', target: 'output/report.xlsx' },
  ] }))
  assert.equal(matchingPendingStep(plan, 'spreadsheet_read', 'input\\template.xlsx')?.id, 'step-1')
  assert.equal(matchingPendingStep(plan, 'spreadsheet_read', 'input/other.xlsx'), undefined)
  assert.deepEqual(additionalOperationStep(plan, 'office_get', 'output/report.xlsx'), {
    id: 'additional-1', title: '追加の操作', tool: 'office_get', target: 'output/report.xlsx', status: 'running', unplanned: true,
  })
})

test('invalid model output falls back to the former fixed three-step plan only', () => {
  const fallback = createStoredPlan('fallback')
  assert.equal(fallback.fallback, true)
  assert.deepEqual(fallback.steps.map(step => step.title), ['依頼内容と入力を確認', '必要な作業を実行', '成果物を確認して完了'])
})
