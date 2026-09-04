import { Agent } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { prepareAgentCustomization } from './customized.js'

const call = (name: string, arguments_: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, arguments_, { id: `misen-${name}` }))
/** Pi's public faux stream seam drives the real Agent loop; it is test-only. */
export async function runReplay(root: string, month: '7月'|'8月', prompt: string) {
  const faux=fauxProvider({ provider:'misen-replay', models:[{id:'gpt-5.6-luna',reasoning:true}] }); const models=createModels(); models.setProvider(faux.provider)
  const file=`output/${month}-月次管理レポート.xlsx`; const rows=month==='7月' ? [['Alpha',1200,700],['Beta',950,500],['Gamma',1100,650]] : [['Alpha',1300,760],['Beta',1020,560],['Gamma',1150,690]]
  const reportRows = rows.map((r, i) => [r[0], r[1], r[2], { formula: `=B${i + 5}-C${i + 5}` }, Number(r[1]) - Number(r[2]) >= ([400, 455, 380][i] ?? 0) ? 'On target' : 'Review'])
  const reportItems = reportRows.flatMap((row, rowIndex) => row.map((value, columnIndex) => {
    const column = String.fromCharCode(65 + columnIndex)
    const props = typeof value === 'object' ? { formula: value.formula } : { value: String(value), type: typeof value === 'number' ? 'number' : 'string' }
    return { command: 'set', path: `/Report/${column}${rowIndex + 5}`, props }
  }))
  faux.setResponses([
    call('workspace_list_files', { path: month, extension: '.xlsx' }),
    call('workspace_read_text', { path: '.agents/skills/monthly-report/SKILL.md' }),
    call('workspace_read_text', { path: '業務引継ぎ.md' }),
    call('spreadsheet_read', { workbook: 'master.xlsx', sheet: 'Targets', range: 'A1:B4' }),
    call('spreadsheet_read', { workbook: `${month}/Alpha.xlsx`, sheet: 'Actuals', range: 'A1:B4' }),
    call('office_create_output', { source: '月次管理レポート_template.xlsx', output: file }),
    call('office_set', { file, path: '/Report/B2', properties: { value: month, type: 'string' } }),
    call('office_batch', { file, items: reportItems }),
    call('office_batch', { file, items: ['B', 'C', 'D'].map(column => ({ command: 'set', path: `/Report/${column}9`, props: { formula: `=SUM(${column}5:${column}7)` } })) }),
    fauxAssistantMessage('Completed the monthly management report.'),
  ])
  const model=models.getModel('misen-replay','gpt-5.6-luna'); if(!model) throw new Error('replay model missing')
  const events: Array<Pick<AgentEvent,'type'> & { name?:string }> = []
  const customization = await prepareAgentCustomization(root)
  const agent=new Agent({initialState:{systemPrompt:customization.systemPrompt,model,thinkingLevel:'medium',tools:[...customization.tools]},streamFn:models.streamSimple.bind(models),toolExecution:'sequential',beforeToolCall:customization.hooks.beforeToolCall,afterToolCall:customization.hooks.afterToolCall})
  agent.subscribe(e=>{ if(e.type==='tool_execution_start') events.push({type:e.type,name:e.toolName}); else if(e.type==='tool_execution_end') events.push({type:e.type,name:e.toolName}); else events.push({type:e.type}) })
  await agent.prompt(prompt); return { agent, events, output:file }
}

export async function runOfficeReplay(root: string, kind: 'word' | 'powerpoint', prompt: string, observe?: (event: AgentEvent) => void) {
  const faux = fauxProvider({ provider: 'misen-office-replay', models: [{ id: 'gpt-5.6-luna', reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const output = kind === 'word' ? 'output/日本語 業務メモ.docx' : 'output/日本語 説明資料.pptx'
  faux.setResponses(kind === 'word' ? [
    call('workspace_list_files', { path: '.', extension: '.docx' }),
    call('office_create_output', { output }),
    call('office_batch', { file: output, items: [
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '業務メモ', style: 'Heading1' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '担当: ミセン担当' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '確認済みです。' } },
    ] }),
    call('office_get', { file: output, path: '/body', depth: 2 }),
    fauxAssistantMessage('Word業務メモを作成しました。'),
  ] : [
    call('workspace_list_files', { path: '.', extension: '.pptx' }),
    call('office_create_output', { output }),
    call('office_batch', { file: output, items: [
      { command: 'add', parent: '/', type: 'slide', props: { title: '月次説明資料', text: '概要', layout: 'titleContent' } },
      { command: 'add', parent: '/', type: 'slide', props: { title: '結論', text: '確認済みです。', layout: 'titleContent' } },
    ] }),
    call('office_get', { file: output, path: '/', depth: 2 }),
    fauxAssistantMessage('PowerPoint説明資料を作成しました。'),
  ])
  const model = models.getModel('misen-office-replay', 'gpt-5.6-luna')
  if (!model) throw new Error('Office replay model missing')
  const events: Array<Pick<AgentEvent, 'type'> & { name?: string }> = []
  const customization = await prepareAgentCustomization(root)
  const agent = new Agent({ initialState: { systemPrompt: customization.systemPrompt, model, thinkingLevel: 'medium', tools: [...customization.tools] }, streamFn: models.streamSimple.bind(models), toolExecution: 'sequential', beforeToolCall: customization.hooks.beforeToolCall, afterToolCall: customization.hooks.afterToolCall })
  agent.subscribe(event => {
    observe?.(event)
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') events.push({ type: event.type, name: event.toolName })
    else events.push({ type: event.type })
  })
  await agent.prompt(prompt)
  return { agent, events, output }
}
