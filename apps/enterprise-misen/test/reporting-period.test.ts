import test from 'node:test'
import { strict as assert } from 'node:assert'
import { deriveSourcePeriod, parseReportPeriod } from '../src/acceptance/validator.js'
const july={year:2024,month:7}, august={year:2024,month:8}; const d=(y:number,m:number)=>new Date(Date.UTC(y,m-1,31))
test('Decision 429 July exact period matrix',()=>{for(const x of ['7月','2024年7月'])assert.deepEqual(parseReportPeriod(x,july),july);for(const x of ['8月','2024年8月','2023年7月','','July','2024-07','x7月','7月x'])assert.throws(()=>parseReportPeriod(x,july))})
test('Decision 429 August exact period matrix',()=>{for(const x of ['8月','2024年8月'])assert.deepEqual(parseReportPeriod(x,august),august);for(const x of ['7月','2024年7月','2023年8月'])assert.throws(()=>parseReportPeriod(x,august))})
test('derive unique source period and reject one-company drift',()=>{assert.deepEqual(deriveSourcePeriod([d(2024,7),d(2024,7),d(2024,7)]),july);assert.throws(()=>deriveSourcePeriod([d(2024,7),d(2024,8),d(2024,7)]));assert.throws(()=>deriveSourcePeriod([d(2024,7),d(2023,7),d(2024,7)]))})
