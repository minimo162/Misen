import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, MONTHS, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { runReplay } from '../src/runtime/agent.js'
import { openSpreadsheetBytes, titles, values } from '../src/spreadsheet/engine.js'
import { snapshotOutputScope, validateReport } from '../src/acceptance/validator.js'
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
for (const scenario of MONTHS) { const root=await mkdtemp(join(tmpdir(),'misen-pi-')); try { await fixture(root); const inputs=new Map(await Promise.all(['master.xlsx','月次管理レポート_template.xlsx',...scenario.companies.map(r=>`${scenario.month}/${r.company}.xlsx`)].map(async p=>[p,hash(await readFile(join(root,p)))] as const))); const outputBefore=await snapshotOutputScope(root);const replay=await runReplay(root,scenario.month as '7月'|'8月',PROMPTS[scenario.month as '7月'|'8月']); await validateReport(root,scenario,inputs,outputBefore); assert.equal(replay.events.filter(e=>e.type==='tool_execution_start').length,8,'Pi tool loop'); console.log(`${scenario.month}: PASS independent SHEET MONTH ROWS PROFIT_FORMULAS STATUS TOTAL FOOTER FORMAT new-output-count input-hashes`) } finally { await rm(root,{recursive:true,force:true}) } }
