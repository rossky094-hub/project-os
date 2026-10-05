import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest, eventReadPolicySchema, WorkflowError, type Project, type Session } from './types.js';
import { evidenceFile, roundData, type RoundCoordinator, type RoundEvent, type Registration, type SyncHistoryEntry } from './rounds.js';
const readBudget=2_000_000;
const envelope=z.object({type:z.string(),thread_id:z.string().optional(),item:z.object({id:z.string(),type:z.string()}).passthrough().optional()}).passthrough();
export function normalizeCodex(raw:unknown):{kind:RoundEvent['kind'];description:RoundEvent['description'];threadId?:string;observeSource?:boolean} {
 const x=envelope.parse(raw);
 if(x.type==='thread.started'){if(!x.thread_id)throw new Error('thread id required');return {kind:'received',description:'stream-start',threadId:x.thread_id};}
 if(x.type==='turn.started')return {kind:'begin',description:'turn-start'};
 if(x.type==='turn.completed')return {kind:'completed',description:'turn-completed'};
 if(x.type==='turn.failed'||x.type==='error')return {kind:'failed',description:'turn-failed'};
 if(['item.started','item.updated','item.completed'].includes(x.type)){
  if(!x.item||!['command_execution','file_change','agent_message','reasoning','mcp_tool_call','web_search','todo_list','error','collab_tool_call','collab_agent_tool_call','collabAgentToolCall'].includes(x.item.type))throw new Error('unsupported item schema');
  return {kind:'checkpoint',observeSource:['file_change','command_execution'].includes(x.item.type)&&x.type==='item.completed',description:x.item.type==='agent_message'&&x.type==='item.completed'?'agent-report-retained-locally':'activity-observed'};
 }
 throw new Error('unsupported Codex event');
}
// Never retain raw chat, reasoning, argv or tool output here. The authorized original
// remains at the registered evidence path; only fixed labels and SHA256 enter state.
export class CodexEventFollower {
 private timer:NodeJS.Timeout|undefined;private closed=false;
 private selections=new Map<string,{revision:string;registrations:Registration[]}>();
 readonly policy:{maxRecordBytes:number};
 constructor(private rounds:RoundCoordinator,private read:(id:string)=>Session,private project:(id:string)=>Project,private ids:()=>string[],policy:unknown={},private revision?:(id:string)=>string){this.policy=eventReadPolicySchema.parse(policy);}
 start(){if(this.timer||this.closed)return;this.poll();this.timer=setInterval(()=>this.poll(),1000);this.timer.unref();}
 stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 poll(){
  if(this.closed)return;
  for(const id of this.ids()){
   const revision=this.revision?.(id),cached=this.selections.get(id);
   const registrations=revision!==undefined&&cached?.revision===revision?cached.registrations:structuredClone(roundData(this.read(id)).registrations.filter(r=>r.binding.tool==='codex-exec'&&r.status!=='unsupported'&&r.status!=='sync-error'&&r.status!=='terminal'&&!r.binding.id.startsWith('obs-')));
   if(revision!==undefined)this.selections.set(id,{revision,registrations});
   for(const r of registrations){
    // A previously observed absent producer is still checked every poll. Once
    // it appears, normal follow performs identity, prefix and event validation.
    if(r.status==='waiting'&&r.offset===0&&!r.delayedRecovery&&r.issue?.startsWith('STREAM_MISSING')){
     try{evidenceFile(this.project(id),r.binding.stream);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;}
    }
    this.follow(id,r.binding.id);
   }
  }
 }
 follow(id:string,registrationId:string){
  let r=roundData(this.read(id)).registrations.find(r=>r.binding.id===registrationId);if(!r)throw new WorkflowError('REFERENCE_UNRESOLVED','登记不存在');if(r.binding.tool!=='codex-exec'||r.binding.id.startsWith('obs-'))throw new WorkflowError('FOLLOWER_ROUTE_REFUSED','选定会话由自动观察器拥有，不能由单轮 follower 重放');if(r.status==='unsupported')return r;
  const maxRecord=this.policy.maxRecordBytes;
  const history=(kind:SyncHistoryEntry['kind'],issue:string|null,at=new Date().toISOString(),limit:number|null=maxRecord)=>{
   const current=roundData(this.read(id)).registrations.find(x=>x.binding.id===registrationId)!;
   const entry:SyncHistoryEntry={kind,issue,at,maxRecordBytes:limit,offset:current.offset,line:current.line,cursor:current.cursor,prefixHash:current.prefixHash};
   this.rounds.update(id,registrationId,{syncHistory:[...(current.syncHistory??[]),entry]});
  };
  // Regular polling excludes sync-error. An explicit replay retains the old error
  // before any issue is cleared, including errors saved by the legacy follower.
  const recovering=r.status==='sync-error';
  if(recovering){
   if(!r.syncHistory?.some(e=>e.kind==='error'))history('error',r.issue,r.lastCheckedAt??r.createdAt,null);
   history('replay',r.issue);this.rounds.update(id,registrationId,{delayedRecovery:true});
  }
  let fd:number|undefined;
  try{
   fd=openSync(evidenceFile(this.project(id),r.binding.stream),'r');const stat=fstatSync(fd),identity=`${stat.dev}:${stat.ino}`;
   const rotated=!!r.fileIdentity&&r.fileIdentity!==identity;
   if(rotated){
    const accepted=roundData(this.read(id)).events.filter(e=>e.event.registrationId===registrationId);
    // Polling never enters recovery. Even explicit replay may only rebind a
    // complete terminal archive, with no unconsumed bytes or pending receipts.
    const complete=recovering&&r.offset>0&&stat.size===r.offset&&r.line>0&&r.cursor===r.line
     &&accepted.length===r.line&&accepted.every(e=>e.event.sequence<=r!.cursor)
     &&accepted.some(e=>e.event.kind==='begin')
     &&accepted.some(e=>e.event.sequence===r!.line&&['completed','failed','cancelled'].includes(e.event.kind));
    if(!complete)throw new WorkflowError('STREAM_ROTATED','事件文件身份已变化；保留原 cursor。已完整消费的终局归档可显式 replay 同登记，严格核对等长完整前缀后恢复；活动流或变化内容须恢复原件');
   }
   if(stat.size<r.offset)throw new WorkflowError('STREAM_TRUNCATED','事件流已截断；保留原 cursor');
   // Validate the consumed prefix on active polls and explicit replay; terminal
   // registrations are skipped by regular polling. Append-only is a contract,
   // not an assumption based solely on file length or inode.
   const hasher=createHash('sha256'),chunk=Buffer.alloc(65536);let position=0;
   while(position<r.offset){const n=readSync(fd,chunk,0,Math.min(chunk.length,r.offset-position),position);if(!n)throw new WorkflowError('STREAM_TRUNCATED','读取期间前缀被截断');hasher.update(chunk.subarray(0,n));position+=n;}
   if(hasher.copy().digest('hex')!==r.prefixHash)throw new WorkflowError('STREAM_CHANGED','已接收前缀发生变化；拒绝覆盖旧记录');
   if(rotated){
    const checked=fstatSync(fd);
    if(checked.size!==r.offset||checked.mtimeMs!==stat.mtimeMs||checked.ctimeMs!==stat.ctimeMs)throw new WorkflowError('STREAM_CHANGED','终局归档在校验期间变化；保留原 cursor 和身份');
    // This restores access to existing evidence only: no read/import loop,
    // source capture, new event, cursor advance or manufactured progress.
    history('recovered',null);
    this.rounds.update(id,registrationId,{fileIdentity:identity,status:'terminal',issue:null,recoveryThroughOffset:null,lastCheckedAt:new Date().toISOString()});
    return roundData(this.read(id)).registrations.find(x=>x.binding.id===registrationId)!;
   }
   if(recovering)this.rounds.update(id,registrationId,{recoveryThroughOffset:stat.size});
   const buffer=Buffer.alloc(Math.min(readBudget,stat.size-r.offset));const count=readSync(fd,buffer,0,buffer.length,r.offset);const data=buffer.subarray(0,count);let start=0,lastStatus:Registration['status']='caught-up';
   while(start<data.length){const end=data.indexOf(10,start);if(end<0){if(data.length-start>maxRecord)throw new WorkflowError('STREAM_RECORD_LIMIT','事件超过单条大小限制');lastStatus=r.offset+data.length-start<stat.size?'following':'partial-line';break;}if(end-start>maxRecord)throw new WorkflowError('STREAM_RECORD_LIMIT','事件超过单条大小限制');
    const bytes=data.subarray(start,end),rawHash=digest(bytes),sequence=r.line+1,key=`codex-${digest(`${r.binding.id}:${sequence}`).slice(0,40)}`;
    const existing=roundData(this.read(id)).events.find(e=>e.event.key===key);
    if(existing){if(existing.event.rawHash!==rawHash)throw new WorkflowError('STREAM_CHANGED','重放事件与已保存 hash 冲突');const replay=normalizeCodex(JSON.parse(bytes.toString('utf8')));if(replay.threadId)r.threadId=replay.threadId;}
    else {
     let normalized:ReturnType<typeof normalizeCodex>;try{normalized=normalizeCodex(JSON.parse(bytes.toString('utf8')));}catch{throw new WorkflowError('STREAM_SCHEMA','事件 JSON 或 schema 无效；保留偏移，未跳过该行');}
     if(normalized.threadId&&r.threadId&&normalized.threadId!==r.threadId)throw new WorkflowError('THREAD_CONFLICT','同一登记出现不同 thread');
     const previousEvents=roundData(this.read(id)).events.filter(e=>e.event.registrationId===r!.binding.id);
     if(normalized.kind==='begin'&&previousEvents.some(e=>e.event.kind==='begin'))throw new WorkflowError('ROUND_BOUNDARY','每个登记只支持一个 Codex turn；后续 turn 须登记真实新轮或恢复 attempt');
     const terminal=['completed','failed'].includes(normalized.kind);
     if(terminal&&!previousEvents.some(e=>e.event.kind==='begin'))throw new WorkflowError('ROUND_BOUNDARY','缺少 turn.started，终局无法归为完整轮次');
     const snapshot=r.binding.mode==='live'&&(normalized.kind==='begin'||terminal||normalized.observeSource)?this.rounds.capture(id,normalized.kind==='checkpoint'):null;
     this.rounds.accept(id,{key,projectId:id,registrationId:r.binding.id,roundId:r.binding.roundId,attemptId:r.binding.attemptId,producerId:r.binding.producerId,sequence,dependsOn:[],kind:normalized.kind,description:normalized.description,rawHash,observedAt:new Date().toISOString(),sourceSnapshotId:snapshot?.id??null,...(snapshot&&roundData(this.read(id)).registrations.find(x=>x.binding.id===registrationId)?.delayedRecovery?{sourceTiming:'recovery-read-time' as const}:{})},true);
     if(normalized.threadId)r.threadId=normalized.threadId;
    }
    hasher.update(data.subarray(start,end+1));r.offset+=end-start+1;r.line++;r.prefixHash=hasher.copy().digest('hex');r.fileIdentity=identity;r.lastCheckedAt=new Date().toISOString();r.status='following';r.issue=null;
    this.rounds.update(id,r.binding.id,{offset:r.offset,line:r.line,prefixHash:r.prefixHash,fileIdentity:identity,threadId:r.threadId,lastCheckedAt:r.lastCheckedAt,status:r.status,issue:null});start=end+1;
   }
   const fresh=roundData(this.read(id)),current=fresh.registrations.find(x=>x.binding.id===registrationId)!;
   if(current.recoveryThroughOffset!=null&&r.offset>=current.recoveryThroughOffset){history('recovered',null);this.rounds.update(id,registrationId,{recoveryThroughOffset:null});}
   const terminal=fresh.events.some(e=>e.event.registrationId===r!.binding.id&&['completed','failed','cancelled'].includes(e.event.kind));
   this.rounds.update(id,r.binding.id,{fileIdentity:identity,status:lastStatus==='partial-line'?'partial-line':r.offset<stat.size?'following':terminal?'terminal':'caught-up',issue:null,lastCheckedAt:new Date().toISOString()});
  }catch(e){const absent=(e as NodeJS.ErrnoException).code==='ENOENT';
   const waiting=absent&&!recovering&&!r.delayedRecovery&&r.offset===0;
   const issue=absent?'STREAM_MISSING：生产者事件文件不存在；未连接':e instanceof WorkflowError?`${e.code}: ${e.message}`:'STREAM_READ_FAILED：无法安全读取事件流';
   if(!waiting)history('error',issue);
   this.rounds.update(id,r.binding.id,{status:waiting?'waiting':'sync-error',issue,lastCheckedAt:new Date().toISOString()});}
  finally{if(fd!==undefined)closeSync(fd);}
  return roundData(this.read(id)).registrations.find(x=>x.binding.id===registrationId)!;
 }
}
