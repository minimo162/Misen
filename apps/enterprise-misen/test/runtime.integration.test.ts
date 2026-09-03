import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { runReplay } from '../src/runtime/agent.js'
// The tool roster itself is asserted once, in security.test.ts (unit tier).
test('public Excel Pi Agent replay drives the real Agent loop through the spreadsheet capabilities',async()=>{const root=await mkdtemp(join(tmpdir(),'misen-pi-test-'));try{await fixture(root);const r=await runReplay(root,'7月',PROMPTS['7月']);const starts=r.events.filter(e=>e.type==='tool_execution_start').map(e=>e.name);assert.deepEqual([...new Set(starts)],['workspace_list_files','workspace_read_text','spreadsheet_read','spreadsheet_create_output','spreadsheet_update']);assert.equal(starts.filter(name=>name==='workspace_read_text').length,2,'selected Skill and handoff use the existing read capability');assert.equal(r.agent.state.errorMessage,undefined)}finally{await rm(root,{recursive:true,force:true})}})
