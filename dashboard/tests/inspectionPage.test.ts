import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeInspectionPage, type InspectionResponse, type InspectionContinuation } from '../src/app/inspectionPage.ts'
import type { SchedulerThreadSnapshot } from '../src/scheduler/types.ts'
const thread={id:'t',context_id:'c',session_id:'s',root_turn_id:'r',generation:2,revision:5,lifecycle:'open',control_state:'active'}
const snapshot={thread,activations:[],schedules:[],pending_signals:[],phase:'waiting'} as unknown as SchedulerThreadSnapshot
const request:InspectionContinuation={kind:'activations',next_cursor:'page-1'}
const response=()=>({thread:{...snapshot.thread},page:{activations:[],signals:[],schedules:[],events:[],has_more:true,next_cursor:'page-2'},jobs:[],activation_snapshots:[],continuations:[]} satisfies InspectionResponse)
test('one requested child page advances only that cursor and retains current phase and receipts',()=>{
 const loaded=mergeInspectionPage(snapshot,[],[request,{kind:'schedules',next_cursor:'other'}],request,response())
 assert.equal(loaded.snapshot.phase,'waiting');assert.equal(loaded.snapshot.thread,snapshot.thread)
 assert.deepEqual(loaded.continuations,[{kind:'schedules',next_cursor:'other'},{...request,next_cursor:'page-2'}])
 assert.deepEqual(loaded.snapshot.activations,[])
 const exhausted=response();exhausted.page.has_more=false;exhausted.page.next_cursor=null as unknown as string
 assert.deepEqual(mergeInspectionPage(snapshot,[],[request],request,exhausted).continuations,[])
})
test('foreign scope, a repeated cursor and oversized child pages are rejected without changing the head',()=>{
 const wrong=response();wrong.thread.generation++
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,wrong),/scope/)
 const repeated=response();repeated.page.next_cursor=request.next_cursor
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,repeated),/boundary/)
 const huge=response();huge.page.events=Array(65).fill({id:'event'})
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,huge),/boundary/)
 assert.equal(snapshot.thread.revision,5)
})

test('fresh heads retain read terminal history without reviving stale live children',async()=>{
 const {retainInspectionHistory}=await import('../src/app/inspectionPage.ts')
 const act=(id:string,status:string)=>({activation:{id,status},jobs:[],signals:[]})
 const prior={...snapshot,activations:[act('finished','succeeded'),act('old-live','running')]} as unknown as SchedulerThreadSnapshot
 const fresh={...snapshot,phase:'idle'} as SchedulerThreadSnapshot
 const retained=retainInspectionHistory(fresh,prior)
 assert.deepEqual(retained.activations.map(a=>a.activation.id),['finished'])
 assert.equal(retained.phase,'idle');assert.equal(retained.thread,fresh.thread)
 assert.equal(retainInspectionHistory({...fresh,thread:{...fresh.thread,generation:3}},prior).activations.length,0)
})

test('nested Activation children and cursor ownership cannot cross a Thread boundary',()=>{
 const a={id:'a',context_id:'c',session_id:'s',root_turn_id:'r'} as SchedulerThreadSnapshot['activations'][number]['activation']
 const valid=response();valid.page.activations=[a];valid.activation_snapshots=[{activation:a,jobs:[],signals:[]}]
 valid.continuations=[{kind:'jobs',activation_id:'a',next_cursor:'jobs-2'}]
 assert.equal(mergeInspectionPage(snapshot,[],[request],request,valid).snapshot.activations.length,1)
 const foreign=response();foreign.page.activations=[a];foreign.activation_snapshots=[{activation:{...a,session_id:'foreign'},jobs:[],signals:[]}]
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,foreign),/Foreign/)
 valid.continuations=[{kind:'jobs',activation_id:'other',next_cursor:'jobs-2'}]
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,valid),/continuation/)
 const kind=response();kind.page.schedules=[{thread_id:'t'} as never]
 assert.throws(()=>mergeInspectionPage(snapshot,[],[request],request,kind),/kind/)
})
