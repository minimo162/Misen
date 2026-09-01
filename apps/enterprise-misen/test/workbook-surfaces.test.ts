import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { enterpriseTools } from '../src/capabilities/tools.js'
import { safeFormula, validateDeliverable } from '../src/capabilities/guards.js'
import { WorkspaceBoundary } from '../src/workspace/boundary.js'
import { createSpreadsheet, formula, serializeSpreadsheet } from '../src/spreadsheet/engine.js'
const tool=(root:string,name:string)=>enterpriseTools(new WorkspaceBoundary(root)).find(x=>x.name===name)!
test('production Pi tools reject authored unsafe formula and cachedValue',async()=>{
 const root=await mkdtemp(join(tmpdir(),'misen-surface-'));try{
  await fixture(root); const create=tool(root,'spreadsheet_create_output');
  await create.execute('c',{source:'月次管理レポート_template.xlsx',output:'output/a.xlsx'},undefined);
  const update=tool(root,'spreadsheet_update');
  await assert.rejects(update.execute('u',{workbook:'output/a.xlsx',sheet:'Report',range:'D5:D5',values:[[{formula:'=WEBSERVICE("https://x")'}]]},undefined));
  await assert.rejects(update.execute('u',{workbook:'output/a.xlsx',sheet:'Report',range:'D5:D5',values:[[{formula:'=SUM(B5:C5)',cachedValue:1}]]},undefined));
  await update.execute('u',{workbook:'output/a.xlsx',sheet:'Report',range:'D5:D5',values:[[{formula:'=SUM(B5:C5)'}]]},undefined);
 }finally{await rm(root,{recursive:true,force:true})}
})
test('carried external workbook surfaces fail closed and internal links remain permitted',()=>{for(const mutate of [(w:any)=>w.externalReferences=[{}],(w:any)=>w.passthrough=new Map([['xl/connections.xml',new Uint8Array()]]),(w:any)=>w.workbookRelsExtras=[{type:'externalLink',target:'https://x'}],(w:any)=>w.workbookRelsExtras=[{type:'x',target:'\\\\server\\x'}],(w:any)=>w.workbookRelsExtras=[{type:'x',target:'C:\\x'}]]){const w=createSpreadsheet(['Report']) as any;mutate(w);assert.throws(()=>validateDeliverable(w))}assert.doesNotThrow(()=>validateDeliverable(createSpreadsheet(['Report']) as any))})
test('serialized malicious source workbook is rejected by production create-output tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-carried-surface-'))
  try {
    await fixture(root)
    const workbook = createSpreadsheet(['Report'])
    formula(workbook, 'Report', 'A1', '=WEBSERVICE("https://example.invalid")')
    await writeFile(join(root, 'malicious-source.xlsx'), await serializeSpreadsheet(workbook))
    await assert.rejects(
      tool(root, 'spreadsheet_create_output').execute('create', { source: 'malicious-source.xlsx', output: 'output/rejected.xlsx' }, undefined),
      /unsafe|not allowed/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
