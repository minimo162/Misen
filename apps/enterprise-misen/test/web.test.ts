import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, encodeRfc5987Value, liveDemoRunner, textFromAssistantMessage, type DemoRunner } from '../src/web/server.js'
import { request } from 'node:http'
test('RFC 5987 artifact filenames encode Unicode and attr-char punctuation',()=>{assert.equal(encodeRfc5987Value("7月's (final).xlsx"),'7%E6%9C%88%27s%20%28final%29.xlsx')})
test('only assistant-role text is eligible for browser-visible conversation output',()=>{
  assert.equal(textFromAssistantMessage({role:'assistant',content:[{type:'text',text:'visible'}]}),'visible')
  assert.equal(textFromAssistantMessage({role:'toolResult',content:[{type:'text',text:'{"workbook":"output/report.xlsx"}'}]}),'')
  assert.equal(textFromAssistantMessage({role:'assistant',content:[{type:'reasoning',text:'private'}]}),'')
})
test('loopback HTTP server validates requests and serves boundary output',async()=>{const root=await mkdtemp(join(tmpdir(),'misen-web-'));await fixture(root);await writeFile(join(root,'output','7月-月次管理レポート.xlsx'),'xlsx');const runner:DemoRunner=async(_r,m)=>({output:`output/${m}-月次管理レポート.xlsx`,tools:['spreadsheet_read'],axes:['SHEET','MONTH']});const server=createDemoServer(root,runner);await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const port=(server.address() as any).port;const base=`http://127.0.0.1:${port}`;try{assert.equal(liveDemoRunner.name,'liveDemoRunner');assert.equal((await fetch(base+'/')).status,200);const badHost=await new Promise<number>(ok=>{const r=request({host:'127.0.0.1',port,path:'/',headers:{host:'evil:1'}},x=>ok(x.statusCode??0));r.end()});assert.equal(badHost,400);assert.equal((await fetch(base+'/run',{method:'POST',headers:{origin:'http://evil','content-type':'application/x-www-form-urlencoded'},body:'prompt=x'})).status,400);assert.equal((await fetch(base+'/run',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded',},body:`x=${'a'.repeat(9000)}`})).status,400);assert.equal((await fetch(base+'/run',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:'prompt=x'})).status,400);const ok=await fetch(base+'/run',{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:`prompt=${encodeURIComponent(PROMPTS['7月'])}`});assert.equal(ok.status,303);const state=await (await fetch(base+'/state')).json() as any;assert.equal(state.status,'PASS');assert.deepEqual(state.axes,['SHEET','MONTH']);assert.deepEqual(state.tools,['spreadsheet_read']);const dl=await fetch(base+'/download');assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition')??'',/filename\*=UTF-8''7%E6%9C%88-%E6%9C%88%E6%AC%A1%E7%AE%A1%E7%90%86%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88\.xlsx/u);assert.equal(await dl.text(),'xlsx')}finally{await new Promise<void>(ok=>server.close(()=>ok()));await rm(root,{recursive:true,force:true})}})

test('browser SSE exposes assistant text only and carries the validated artifact on terminal status',async()=>{
  const root=await mkdtemp(join(tmpdir(),'misen-web-events-'))
  await fixture(root)
  await writeFile(join(root,'output','validated.xlsx'),'xlsx')
  const runner:DemoRunner=async(_root,_month,_prompt,context)=>{
    context?.emit({type:'assistant',text:'Brain final answer'})
    return {output:'output/validated.xlsx',tools:[],axes:['SHEET:PASS'],status:'PASS'}
  }
  const server=createDemoServer(root,runner)
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok))
  const port=(server.address() as any).port
  const base=`http://127.0.0.1:${port}`
  try {
    const controller=new AbortController()
    const stream=await fetch(base+'/events',{signal:controller.signal})
    const reader=stream.body!.getReader()
    let text=''
    const readUntilTerminal=async()=>{
      while(!text.includes('"status":"PASS"')){
        const chunk=await reader.read()
        if(chunk.done)break
        text+=new TextDecoder().decode(chunk.value)
      }
    }
    const run=fetch(base+'/run',{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:`prompt=${encodeURIComponent(PROMPTS['7月'])}`})
    await readUntilTerminal()
    await run
    controller.abort()
    assert.match(text,/Brain final answer/u)
    assert.equal((text.match(/Brain final answer/gu)??[]).length,1)
    assert.doesNotMatch(text,/月次管理レポートを作成しました/u)
    assert.match(text,/"status":"PASS","output":"output\/validated\.xlsx"/u)
  } finally {
    await new Promise<void>(ok=>server.close(()=>ok()))
    await rm(root,{recursive:true,force:true})
  }
})
