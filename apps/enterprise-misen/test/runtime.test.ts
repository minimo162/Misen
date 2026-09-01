import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { ENTERPRISE_TOOL_NAMES } from '../src/capabilities/tools.js'
import { runReplay } from '../src/runtime/agent.js'
test('five capabilities and public Pi Agent replay',async()=>{assert.deepEqual(ENTERPRISE_TOOL_NAMES,['workspace_list_files','workspace_read_text','spreadsheet_read','spreadsheet_create_output','spreadsheet_update']);const root=await mkdtemp(join(tmpdir(),'misen-pi-test-'));try{await fixture(root);const r=await runReplay(root,'7月',PROMPTS['7月']);assert.ok(r.events.some(e=>e.type==='tool_execution_start'));assert.equal(r.agent.state.errorMessage,undefined)}finally{await rm(root,{recursive:true,force:true})}})
