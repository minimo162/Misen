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
  faux.setResponses([
    call('workspace_list_files', { path: month, extension: '.xlsx' }),
    call('workspace_read_text', { path: '.agents/skills/monthly-report/SKILL.md' }),
    call('workspace_read_text', { path: '業務引継ぎ.md' }),
    call('spreadsheet_read', { workbook: 'master.xlsx', sheet: 'Targets', range: 'A1:B4' }),
    call('spreadsheet_read', { workbook: `${month}/Alpha.xlsx`, sheet: 'Actuals', range: 'A1:B4' }),
    call('spreadsheet_create_output', { source: '月次管理レポート_template.xlsx', output: file }),
    call('spreadsheet_update', { workbook: file, sheet: 'Report', range: 'B2:B2', values: [[month]] }),
    call('spreadsheet_update', { workbook: file, sheet: 'Report', range: 'A5:E7', values: reportRows }),
    call('spreadsheet_update', { workbook: file, sheet: 'Report', range: 'B9:D9', values: [[{ formula: '=SUM(B5:B7)' }, { formula: '=SUM(C5:C7)' }, { formula: '=SUM(D5:D7)' }]] }),
    fauxAssistantMessage('Completed the monthly management report.'),
  ])
  const model=models.getModel('misen-replay','gpt-5.6-luna'); if(!model) throw new Error('replay model missing')
  const events: Array<Pick<AgentEvent,'type'> & { name?:string }> = []
  const customization = await prepareAgentCustomization(root)
  const agent=new Agent({initialState:{systemPrompt:customization.systemPrompt,model,thinkingLevel:'medium',tools:[...customization.tools]},streamFn:models.streamSimple.bind(models),toolExecution:'sequential',beforeToolCall:customization.hooks.beforeToolCall,afterToolCall:customization.hooks.afterToolCall})
  agent.subscribe(e=>{ if(e.type==='tool_execution_start') events.push({type:e.type,name:e.toolName}); else if(e.type==='tool_execution_end') events.push({type:e.type,name:e.toolName}); else events.push({type:e.type}) })
  await agent.prompt(prompt); return { agent, events, output:file }
}
