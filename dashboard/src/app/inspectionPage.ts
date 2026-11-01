import type { SchedulerThreadSnapshot, SchedulerActivationSnapshot, SchedulerJobSnapshot, ThreadDetailResponse, ThreadRecord, ScheduleRecord, ThreadSignalRecord } from '../scheduler/types.ts'
export type InspectionKind = 'dependencies' | 'activations' | 'jobs' | 'pending_signals' | 'activation_signals' | 'schedules' | 'model_events'
export interface InspectionContinuation {kind:InspectionKind; activation_id?:string|null; next_cursor:string}
export interface InspectionResponse {
 thread:ThreadRecord
 page:{dependencies?:NonNullable<SchedulerThreadSnapshot['dependencies']>;activations:SchedulerActivationSnapshot['activation'][]; signals:ThreadSignalRecord[]; schedules:ScheduleRecord[]; events:ThreadDetailResponse['model_attempt_events']; has_more:boolean; next_cursor:string|null}
 jobs:SchedulerJobSnapshot[]
 activation_snapshots:SchedulerActivationSnapshot[]
 continuations:InspectionContinuation[]
}
export const inspectionSlot=(page:Pick<InspectionContinuation,'kind'|'activation_id'>)=>`${page.kind}:${page.activation_id??''}`
function merge<T>(current:T[],incoming:T[],id:(v:T)=>string):T[] {
 // A history continuation never overwrites a newer head/control receipt.
 const revision=(value:T)=>{
  const row=value as {revision?:number;job?:{revision?:number};activation?:{revision?:number}}
  return row.revision??row.job?.revision??row.activation?.revision??-1
 }
 const rows=new Map(incoming.map(row=>[id(row),row]));for(const row of current){const old=rows.get(id(row));if(!old||revision(row)>=revision(old))rows.set(id(row),row)}return [...rows.values()]
}
export function mergeInspectionPage(snapshot:SchedulerThreadSnapshot,events:ThreadDetailResponse['model_attempt_events'],continuations:InspectionContinuation[],request:InspectionContinuation,response:InspectionResponse) {
 const t=snapshot.thread, next=response.thread
 if(t.id!==next.id||t.context_id!==next.context_id||t.session_id!==next.session_id||t.root_turn_id!==next.root_turn_id||t.generation!==next.generation)throw Error('Thread inspection scope changed')
 const p=response.page
 if([p.dependencies??[],p.activations,p.signals,p.schedules,p.events,response.jobs].some(items=>items.length>64)|| (p.has_more&&(!p.next_cursor||p.next_cursor===request.next_cursor)))throw Error('Thread inspection page boundary changed')
 if(p.activations.some(a=>a.context_id!==t.context_id||a.root_turn_id!==t.root_turn_id)||response.jobs.some(j=>j.job.thread_id!==t.id||j.job.context_id!==t.context_id||j.job.activation_id!==request.activation_id)||p.signals.some(s=>s.thread_id!==t.id)||p.schedules.some(s=>s.thread_id!==t.id))throw Error('Foreign inspection child')
 if(p.dependencies?.some(d=>d.owner_kind!=="thread"||d.owner_id!==t.id||d.owner_generation!==t.generation))throw Error('Foreign inspection dependency')
 const currentActivations=new Set(snapshot.activations.map(a=>a.activation.id))
 const pageActivations=new Set(p.activations.map(a=>a.id))
 const inScope=(a:SchedulerActivationSnapshot['activation'])=>a.context_id===t.context_id&&a.session_id===t.session_id&&a.root_turn_id===t.root_turn_id
 const jobInScope=(j:SchedulerJobSnapshot,activationId:string)=>j.job.context_id===t.context_id&&j.job.thread_id===t.id&&j.job.activation_id===activationId&&(!j.approval||j.approval.job_id===j.job.id)
 if(response.activation_snapshots.length>64||response.activation_snapshots.length!==p.activations.length
   ||new Set(response.activation_snapshots.map(a=>a.activation.id)).size!==pageActivations.size
   ||p.activations.some(a=>!inScope(a))
   ||response.activation_snapshots.some(a=>!pageActivations.has(a.activation.id)||!inScope(a.activation)||a.jobs.length>32||a.signals.length>32||a.jobs.some(j=>!jobInScope(j,a.activation.id))||a.signals.some(s=>s.thread_id!==t.id)))throw Error('Foreign inspection activation')
 if(['jobs','activation_signals'].includes(request.kind)&&(!request.activation_id||!currentActivations.has(request.activation_id)))throw Error('Unknown inspection activation')
 if(response.jobs.some(j=>!jobInScope(j,request.activation_id??'')))throw Error('Foreign inspection job')
 const seenSlots=new Set<string>()
 for(const c of response.continuations){
  const slot=inspectionSlot(c)
  if(seenSlots.has(slot)||!['jobs','activation_signals'].includes(c.kind)||!c.activation_id||!pageActivations.has(c.activation_id)||!c.next_cursor||c.next_cursor.length>4096)throw Error('Foreign inspection continuation')
  seenSlots.add(slot)
 }
 if((request.kind!=='dependencies'&&(p.dependencies?.length??0))
   ||(request.kind!=='activations'&&(p.activations.length||response.activation_snapshots.length))
   ||(request.kind!=='jobs'&&response.jobs.length)
   ||(!['pending_signals','activation_signals'].includes(request.kind)&&p.signals.length)
   ||(request.kind!=='schedules'&&p.schedules.length)
   ||(request.kind!=='model_events'&&p.events.length)
   ||p.has_more!==!!p.next_cursor)throw Error('Thread inspection kind changed')
 const activations=merge(snapshot.activations,response.activation_snapshots,a=>a.activation.id).map(a=>({
  ...a,
  jobs:request.kind==='jobs'&&a.activation.id===request.activation_id?merge(a.jobs,response.jobs,j=>j.job.id):a.jobs,
  signals:request.kind==='activation_signals'&&a.activation.id===request.activation_id?merge(a.signals,p.signals,s=>s.id):a.signals,
 }))
 const replacement=continuations.filter(c=>inspectionSlot(c)!==inspectionSlot(request))
 for(const c of response.continuations)if(!replacement.some(current=>inspectionSlot(current)===inspectionSlot(c)))replacement.push(c)
 if(p.has_more)replacement.push({...request,next_cursor:p.next_cursor!})
 return {
  snapshot:{...snapshot,dependencies_loaded:request.kind==='dependencies'?!p.has_more:snapshot.dependencies_loaded,dependencies:request.kind==='dependencies'?merge(snapshot.dependencies??[],p.dependencies??[],d=>d.id):snapshot.dependencies,activations,pending_signals:request.kind==='pending_signals'?merge(snapshot.pending_signals,p.signals,s=>s.id):snapshot.pending_signals,schedules:request.kind==='schedules'?merge(snapshot.schedules,p.schedules,s=>s.id):snapshot.schedules},
  events:merge(events,p.events,e=>e.id).sort((a,b)=>(a.sequence??0)-(b.sequence??0)),
  continuations:replacement,
 }
}

export const inspectionScope=(snapshot:SchedulerThreadSnapshot)=>JSON.stringify([snapshot.thread.context_id,snapshot.thread.session_id,snapshot.thread.id,snapshot.thread.root_turn_id,snapshot.thread.generation])
/** Keep explicitly read immutable history when the current head changes. A
 * retained nonterminal child is never presented as a fresh running fact. */
export function retainInspectionHistory(head:SchedulerThreadSnapshot,retained:SchedulerThreadSnapshot):SchedulerThreadSnapshot {
 if(inspectionScope(head)!==inspectionScope(retained))return head
 const terminalJobs=(rows:SchedulerJobSnapshot[])=>rows.filter(j=>['succeeded','failed','cancelled','lost'].includes(j.job.status))
 const old=new Map(retained.activations.map(a=>[a.activation.id,a]))
 const activations=head.activations.map(a=>{
  const previous=old.get(a.activation.id);old.delete(a.activation.id)
  return previous?{...a,jobs:merge(a.jobs,terminalJobs(previous.jobs),j=>j.job.id),signals:merge(a.signals,previous.signals.filter(s=>s.status==='acknowledged'),s=>s.id)}:a
 })
 activations.push(...[...old.values()].filter(a=>['succeeded','failed','cancelled'].includes(a.activation.status)).map(a=>({...a,jobs:terminalJobs(a.jobs),signals:a.signals.filter(s=>s.status==='acknowledged')})))
 return {...head,activations,schedules:merge(head.schedules,retained.schedules.filter(s=>['completed','cancelled','dispatched'].includes(s.status)),s=>s.id)}
}
