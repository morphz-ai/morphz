import assert from 'node:assert/strict'
import test from 'node:test'
import { DashboardApiClient } from '../src/api/client.ts'
import { readDirectoryPage, readNavigationHead, mergeDirectoryPage } from '../src/app/directoryPage.ts'

test('one picker demand reads one 50-row page, and only an explicit continuation reads the next', async () => {
  const requests: URL[] = []
  const api = new DashboardApiClient({baseUrl: 'http://directory.test', fetchImpl: (async input => {
    const url = new URL(String(input)); requests.push(url)
    const start = url.searchParams.get('cursor') ? 50 : 0
    return Response.json({sessions: Array.from({length:50}, (_, i) => ({id:`s-${String(start+i).padStart(4,'0')}`,context_id:'chosen'})),has_more:true,next_cursor:`opaque-${start+49}`})
  }) as typeof fetch})
  const first = await readDirectoryPage<{id:string}>(api, 'sessions', {principalId:'human/one',contextId:'chosen'})
  assert.equal(requests.length,1)
  assert.equal(first.items.length,50)
  assert.equal(requests[0]!.pathname,'/api/operator/principals/human%2Fone/sessions')
  assert.equal(requests[0]!.searchParams.get('context_id'),'chosen')
  const second = await readDirectoryPage<{id:string}>(api,'sessions',{principalId:'human/one',contextId:'chosen'},{cursor:first.nextCursor!})
  assert.equal(requests.length,2)
  assert.equal(requests[1]!.searchParams.get('cursor'),'opaque-49')
  assert.equal(mergeDirectoryPage(first.items,second.items).length,100)
})

test('an exact selected identity is a single metadata point, never a registry traversal', async () => {
  const paths: string[]=[]
  const api = new DashboardApiClient({baseUrl:'http://directory.test',fetchImpl:(async input=>{
    const url=new URL(String(input));paths.push(url.pathname+url.search)
    assert.deepEqual(JSON.parse(url.searchParams.get('ids')!),['selected-outside-head'])
    assert.equal(url.searchParams.get('limit'),'1')
    return Response.json({contexts:[{id:'selected-outside-head'}],has_more:false,next_cursor:null})
  }) as typeof fetch})
  await readDirectoryPage(api,'contexts',{}, {id:'selected-outside-head'})
  assert.equal(paths.length,1)
  assert.ok(!paths[0]!.includes('/overview') && !paths[0]!.includes('/events'))
})

test('oversized, foreign, duplicate and non-advancing pages fail rather than being sliced or called complete',async()=>{
  for(const response of [
    {sessions:Array.from({length:51},(_,i)=>({id:String(i),context_id:'chosen'})),has_more:false,next_cursor:null},
    {sessions:[{id:'foreign',context_id:'elsewhere'}],has_more:false,next_cursor:null},
    {sessions:[{id:'same',context_id:'chosen'},{id:'same',context_id:'chosen'}],has_more:false,next_cursor:null},
    {sessions:[],has_more:true,next_cursor:'fake'},
    {sessions:[{id:'same',context_id:'chosen'}],has_more:true,next_cursor:'same'},
  ]) {
    let reads=0
    const api=new DashboardApiClient({baseUrl:'http://directory.test',fetchImpl:(async()=>{reads++;return Response.json(response)}) as typeof fetch})
    await assert.rejects(readDirectoryPage(api,'sessions',{contextId:'chosen'},{cursor:'same'}))
    assert.equal(reads,1)
  }
})


test('a closed navigation header reads exact metadata only; opening a picker owns just its head', async () => {
  for (const contextsOpen of [false, true]) for (const sessionsOpen of [false, true]) {
    const requests: URL[] = []
    const api = new DashboardApiClient({baseUrl: 'http://directory.test', fetchImpl: (async input => {
      const url = new URL(String(input)); requests.push(url)
      const kind = url.pathname.split('/').at(-1)!
      const items = kind === 'agents' ? [{id:'a'}] : kind === 'contexts' ? [{id:'c',agent_id:'a',status:'active'}] : [{id:'s',context_id:'c',status:'active'}]
      return Response.json({[kind]:items,has_more:false,next_cursor:null})
    }) as typeof fetch})
    const head = await readNavigationHead(api, {contextId:'c',sessionId:'s',defaultContextId:'default',defaultAgentId:'default',contextsOpen,sessionsOpen})
    assert.equal(head.contextId,'c')
    assert.equal(requests.length,3+Number(contextsOpen)+Number(sessionsOpen))
    assert.equal(requests.filter(url => !url.searchParams.has('ids')).length,Number(contextsOpen)+Number(sessionsOpen))
    assert.ok(requests.every(url => !/jobs|events|leases|nodes|scheduler/.test(url.pathname)))
    assert.ok(requests.filter(url => !url.searchParams.has('ids')).every(url => url.searchParams.get('include_archived') === 'false'))
  }
})

test('an explicit empty selection performs no read and cannot turn into the directory head', async () => {
  let count=0
  const api={get:async()=>{count++; throw new Error('unexpected')}}
  assert.deepEqual(await readDirectoryPage(api,'sessions',{}, {ids:[]}),{items:[],hasMore:false,nextCursor:null})
  assert.equal(count,0)
})


test('a missing selected point cannot silently redirect a source jump to a different Session head',async()=>{
  const paths:URL[]=[]
  const api=new DashboardApiClient({baseUrl:'http://directory.test',fetchImpl:(async input=>{
    const url=new URL(String(input));paths.push(url)
    const kind=url.pathname.split('/').at(-1)!
    return Response.json({[kind]:kind==='agents'?[{id:'a'}]:kind==='contexts'?[{id:'c',agent_id:'a',status:'active'}]:[],has_more:false,next_cursor:null})
  }) as typeof fetch})
  await assert.rejects(readNavigationHead(api,{contextId:'c',sessionId:'known-source',defaultContextId:'default',defaultAgentId:'default'}),/Selected Session/)
  assert.equal(paths.length,3)
  assert.ok(paths.every(url=>url.searchParams.has('ids')))
})
