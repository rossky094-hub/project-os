import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { activityConnectionSchema, activityData, decodeCodexActivity, type ActivityConnection, type DecodedActivity } from './agent-activity.js';
import { currentMainlineView, validateMainlineIntent } from './mainline-progress.js';
import { contained } from './source.js';
import { discoverSource } from './source.js';
import { evidenceFile, roundData, type RoundCoordinator, type RoundEvent } from './rounds.js';
import { digest, WorkflowError, type Project, type Session } from './types.js';
import type { SessionStore } from './store.js';

const now=()=>new Date().toISOString();
const readBudget=2_000_000;
const maxLinesPerPoll=64;
const maxActivitiesPerPoll=8;
function prefixHasher(fd:number,length:number){const h=createHash('sha256'),chunk=Buffer.alloc(65536);let pos=0;while(pos<length){const n=readSync(fd,chunk,0,Math.min(chunk.length,length-pos),pos);if(!n)throw new WorkflowError('STREAM_TRUNCATED','事件流前缀在读取时被截断');h.update(chunk.subarray(0,n));pos+=n;}return h;}
function lineIdentity(c:ActivityConnection,n:number){return `activity-${digest(`${c.id}:${n}`).slice(0,40)}`;}
function roundIdentity(c:ActivityConnection,turn:string){return digest(`${c.id}:${turn}`).slice(0,32);}
function verifyNativeCwd(cwd:string|undefined,project:Project){
 if(!cwd)throw new WorkflowError('IDENTITY_UNRESOLVED','本机会话缺少工作目录');
 try{if(contained(project.sourceRoot,realpathSync(cwd)))return;}catch{/* Missing or unreadable cwd cannot attest this worktree. */}
 throw new WorkflowError('IDENTITY_UNRESOLVED','本机会话工作目录不属于已登记工作树');
}
function verifyNativeSession(fact:DecodedActivity,version:string,project:Project){
 if(fact.kind!=='session'||!fact.threadId||fact.toolVersion!==version)throw new WorkflowError('IDENTITY_UNRESOLVED','本机会话身份或版本与声明不符');
 verifyNativeCwd(fact.cwd,project);
}
function nativeHeader(fd:number,limit:number,project:Project,version:string){
 const stat=fstatSync(fd),head=Buffer.alloc(Math.min(stat.size,limit+1));readSync(fd,head,0,head.length,0);const end=head.indexOf(10);
 if(end<0)throw new WorkflowError('STREAM_HEADER','选定流首行不完整或超过事件上限');
 let raw:unknown;try{raw=JSON.parse(head.subarray(0,end).toString('utf8'));}catch{throw new WorkflowError('STREAM_HEADER','选定流首行 JSON 无效');}
 const fact=decodeCodexActivity('codex-native-rollout',raw,project);verifyNativeSession(fact,version,project);return fact;
}

// One selected file is read under its registered evidence root. Source bodies
// stay in that file; only compact identities, activity and hashes are persisted.
export class CodexSessionObserver {
 private timer:NodeJS.Timeout|undefined;private closed=false;private polling=false;
 private idleFiles=new Map<string,{signature:string;offset:number}>();
 constructor(private store:SessionStore,private rounds:RoundCoordinator,private read:(id:string)=>Session,private project:(id:string)=>Project,private ids:()=>string[],private maxRecordBytes:number){}
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>this.pollAll(),1000);this.timer.unref();this.pollAll();}
 stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 pollAll(){if(this.closed||this.polling)return;this.polling=true;try{for(const id of this.ids())for(const c of activityData(this.read(id)).connections)if(c.status!=='sync-error'&&c.status!=='unsupported')this.poll(id,c.id);}finally{this.polling=false;}}
 connect(id:string,raw:unknown):ActivityConnection{
  const req=activityConnectionSchema.parse(raw),p=this.project(id),s=this.read(id);
  if(req.projectId!==id||realpathSync(req.repoRoot)!==p.sourceRoot||realpathSync(req.worktreeRoot)!==p.sourceRoot)throw new WorkflowError('IDENTITY_UNRESOLVED','连接须属于已登记工作树');
  if(req.format==='codex-native-rollout'&&req.toolVersion!=='0.155.0-alpha.9.2'||req.format==='codex-exec-jsonl'&&!['0.155.0-alpha.2.6','0.155.0-alpha.9.2'].includes(req.toolVersion))throw new WorkflowError('UNSUPPORTED_VERSION','该工具版本没有已确认的事件适配器');
  const goal=s.goals.at(-1);if(goal?.hash!==req.goalHash||req.clauseIds.some(x=>!goal.clauses.some(c=>c.id===x)))throw new WorkflowError('STALE_GOAL','连接须绑定当前目标与条款');
  if(req.selectedActionIds.some(x=>!s.actions.some(a=>a.id===x)))throw new WorkflowError('REFERENCE_UNRESOLVED','所选建议不存在');
  if(req.mainlineIntent){
   const sourceHash=discoverSource(p).hash,view=currentMainlineView(s,sourceHash);
   if(!view||req.journeyIds.length!==1||req.journeyIds[0]!==req.mainlineIntent.journeyId)
    throw new WorkflowError('STALE_MAINLINE','连接的旅程需要当前目标、来源和分析视图',409);
   validateMainlineIntent(req.mainlineIntent,view,sourceHash);
  }
  const file=evidenceFile(p,req.stream);if(contained(this.store.root,resolve(file)))throw new WorkflowError('ANALYZER_STREAM_REFUSED','分析器数据目录不能作为开发流');
  if(activityData(s).connections.some(c=>c.id===req.id||realpathSync(evidenceFile(p,c.stream))===realpathSync(file)))throw new WorkflowError('CONNECTION_CONFLICT','连接或选定流已登记',409);
  const fd=openSync(file,'r');let size:number,identity:string,hashBefore:string,selectedThread:string|null=null;
  try{const stat=fstatSync(fd);size=stat.size;identity=`${stat.dev}:${stat.ino}`;
   if(size){
    if(req.format==='codex-native-rollout')selectedThread=nativeHeader(fd,this.maxRecordBytes,p,req.toolVersion).threadId;
    else {const head=Buffer.alloc(Math.min(size,this.maxRecordBytes+1));readSync(fd,head,0,head.length,0);const end=head.indexOf(10);
     if(end<0)throw new WorkflowError('STREAM_HEADER','选定流首行不完整或超过事件上限');
     let first:unknown;try{first=JSON.parse(head.subarray(0,end).toString('utf8'));}catch{throw new WorkflowError('STREAM_HEADER','选定流首行 JSON 无效');}
     const fact=decodeCodexActivity(req.format,first,p);if(fact.kind!=='session'||!fact.threadId)throw new WorkflowError('STREAM_HEADER','选定流首行须为对应格式的会话身份');selectedThread=fact.threadId;
    }
   }
   if(req.start==='from-now'&&size){const last=Buffer.alloc(1);readSync(fd,last,0,1,size-1);if(last[0]!==10)throw new WorkflowError('FROM_NOW_BOUNDARY','已有流末尾不是完整行；请等待完整行或显式历史回放');}
   hashBefore=req.start==='from-now'?prefixHasher(fd,size).digest('hex'):digest('');
  }finally{closeSync(fd);}
  if(req.start==='historical-replay'&&!req.beforeSnapshotId)throw new WorkflowError('BASELINE_REQUIRED','历史回放须指定真实既有基线，不以当前来源冒充过去');
  if(req.beforeSnapshotId&&!roundData(s).snapshots.some(x=>x.id===req.beforeSnapshotId))throw new WorkflowError('BASELINE_REQUIRED','指定基线不存在');
  const baseline=req.start==='from-now'?this.rounds.capture(id,true).id:req.beforeSnapshotId!;
  const fresh=this.read(id),d=fresh.agentActivity??={connections:[],events:[],revision:0};
  const connection:ActivityConnection={...req,createdAt:now(),offset:req.start==='from-now'?size:0,prefixHash:hashBefore,fileIdentity:identity,line:0,cursor:0,status:'caught-up',issue:null,lastReceivedAt:null,lastCheckedAt:null,currentTurnId:null,currentRoundId:null,roundSequence:0,threadId:selectedThread,metadataVerified:req.format==='codex-native-rollout'&&req.start==='from-now'&&size>0,baselineSnapshotId:baseline,ignoredCount:0,history:[]};
  d.connections.push(connection);d.revision++;this.store.save(fresh);return connection;
 }
 replay(id:string,connectionId:string){const c=this.connection(id,connectionId);if(c.status!=='sync-error')return c;const s=this.read(id),entry=activityData(s).connections.find(x=>x.id===connectionId)!;entry.history.push({kind:'replay',at:now(),issue:entry.issue,offset:entry.offset,cursor:entry.cursor});entry.status='caught-up';entry.issue=null;this.store.save(s);const result=this.poll(id,connectionId);if(result.status!=='sync-error'){const fresh=this.read(id),current=activityData(fresh).connections.find(x=>x.id===connectionId)!;current.history.push({kind:'recovered',at:now(),issue:null,offset:current.offset,cursor:current.cursor});this.store.save(fresh);}return result;}
 private connection(id:string,connectionId:string){const c=activityData(this.read(id)).connections.find(x=>x.id===connectionId);if(!c)throw new WorkflowError('REFERENCE_UNRESOLVED','观察连接不存在');return c;}
 poll(id:string,connectionId:string):ActivityConnection{
  const cacheKey=`${id}:${connectionId}`;let fd:number|undefined;
  try{
   let s=this.read(id),c=activityData(s).connections.find(x=>x.id===connectionId);if(!c)throw new WorkflowError('REFERENCE_UNRESOLVED','观察连接不存在');
   if(c.status==='unsupported'||c.status==='sync-error')return c;
   const p=this.project(id);fd=openSync(evidenceFile(p,c.stream),'r');const stat=fstatSync(fd),identity=`${stat.dev}:${stat.ino}`;
   if(c.fileIdentity&&c.fileIdentity!==identity)throw new WorkflowError('STREAM_ROTATED','选定流文件身份变化；保留原 cursor');
   if(stat.size<c.offset)throw new WorkflowError('STREAM_TRUNCATED','选定流已截断；保留原 cursor');
   if(c.format==='codex-native-rollout'&&!c.metadataVerified&&c.offset>0){
    const header=nativeHeader(fd,this.maxRecordBytes,p,c.toolVersion);
    if(c.threadId&&c.threadId!==header.threadId)throw new WorkflowError('THREAD_CONFLICT','原始会话元数据与已登记线程不符');
    c.metadataVerified=true;c.threadId=header.threadId;activityData(s).revision++;this.store.save(s);
    s=this.read(id);c=activityData(s).connections.find(x=>x.id===connectionId)!;
   }
   const signature=`${identity}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
   const cached=this.idleFiles.get(cacheKey);
   if(cached?.signature===signature&&cached.offset===c.offset&&(c.offset===stat.size||c.status==='partial-line'))return c;
   const hasher=prefixHasher(fd,c.offset);
   if(hasher.copy().digest('hex')!==c.prefixHash)throw new WorkflowError('STREAM_CHANGED','已接收前缀被改写；保留原 cursor');
   const readStart=c.offset,data=Buffer.alloc(Math.min(readBudget,stat.size-readStart)),count=readSync(fd,data,0,data.length,readStart);
   let start=0,lines=0,activities=0,partial=false,dirty=false;
   while(start<count&&lines<maxLinesPerPoll&&activities<maxActivitiesPerPoll){
    const end=data.indexOf(10,start);
    if(end<0){if(count-start>this.maxRecordBytes)throw new WorkflowError('STREAM_RECORD_LIMIT','事件超过已登记大小限制');partial=true;break;}
    if(end-start>this.maxRecordBytes)throw new WorkflowError('STREAM_RECORD_LIMIT','事件超过已登记大小限制');
    const bytes=data.subarray(start,end),rawHash=digest(bytes),line=c.line+1,eventId=lineIdentity(c,line);
    let parsed:unknown;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new WorkflowError('STREAM_SCHEMA','事件 JSON 无效；保留偏移，不跳过该行');}
    const fact=decodeCodexActivity(c.format,parsed,p),old=activityData(s).events.find(e=>e.id===eventId);
    if(old&&old.rawHash!==rawHash)throw new WorkflowError('STREAM_CHANGED','重放行与已保存事件 hash 冲突');
    hasher.update(data.subarray(start,end+1));
    const recheck=this.record(id,s,c,fact,eventId,line,rawHash,readStart+end+1,hasher.copy().digest('hex'),identity);
    dirty=true;lines++;if(fact.kind!=='ignored')activities++;
    if(fact.kind!=='ignored'||old){this.store.save(s);dirty=false;if(recheck)this.rounds.recheck(id);s=this.read(id);c=activityData(s).connections.find(x=>x.id===connectionId)!;}
    start=end+1;
   }
   c=activityData(s).connections.find(x=>x.id===connectionId)!;
   const status=c.offset<stat.size?(partial?'partial-line':'following'):'caught-up';
   if(c.status!==status){c.status=status;dirty=true;}
   if(dirty)this.store.save(s);
   this.idleFiles.set(cacheKey,{signature,offset:c.offset});
  }catch(e){this.idleFiles.delete(cacheKey);const issue=e instanceof WorkflowError?`${e.code}: ${e.message}`:'STREAM_READ_FAILED: 无法安全读取选定流';const s=this.read(id),current=activityData(s).connections.find(x=>x.id===connectionId)!;
   if(current.status!=='sync-error'||current.issue!==issue){current.status='sync-error';current.issue=issue;current.lastCheckedAt=now();current.history.push({kind:'error',at:current.lastCheckedAt,issue,offset:current.offset,cursor:current.cursor});this.store.save(s);}
  }finally{if(fd!==undefined)closeSync(fd);}
  return this.connection(id,connectionId);
 }
 private record(id:string,s:Session,c:ActivityConnection,fact:DecodedActivity,eventId:string,line:number,rawHash:string,nextOffset:number,nextPrefixHash:string,identity:string):boolean{
  const p=this.project(id),d=activityData(s);
  if(c.format==='codex-native-rollout'){
   if(fact.kind==='session')verifyNativeSession(fact,c.toolVersion,p);
   else if(!c.metadataVerified)throw new WorkflowError('IDENTITY_UNRESOLVED','须先收到匹配的本机会话元数据');
   if(fact.emittingThreadId&&fact.emittingThreadId!==c.threadId)throw new WorkflowError('THREAD_CONFLICT','事件不属于所选根会话');
   if(fact.kind==='turn-start'){
    verifyNativeCwd(fact.cwd,p);
    if(fact.rootTurnId!==fact.turnId)throw new WorkflowError('IDENTITY_UNRESOLVED','turn_context 不是所选根轮次');
   }
   if(['turn-complete','turn-failed','turn-cancelled'].includes(fact.kind)&&fact.turnId&&c.currentTurnId&&fact.turnId!==c.currentTurnId)throw new WorkflowError('TURN_CONFLICT','终局事件不属于当前已核对轮次');
  }
  let turnId=fact.turnId??c.currentTurnId,roundId=c.currentRoundId;
  if(fact.kind==='turn-start'){
   if(c.format==='codex-exec-jsonl'&&!fact.turnId){if(c.currentTurnId)throw new WorkflowError('TURN_ID_REQUIRED','重复 exec turn 缺显式 turn_id；不能猜测继续/新轮');turnId=`exec-event-${line}`;}
   if(!turnId)throw new WorkflowError('TURN_ID_REQUIRED','开发轮次缺真实身份');
   if(c.currentTurnId!==turnId){
    if(s.goals.at(-1)?.hash===c.goalHash){
     const prefix=roundIdentity(c,turnId),existing=roundData(s).registrations.find(r=>r.binding.id===`obs-${prefix}`);
     if(existing)roundId=existing.binding.roundId;
     else {
      const snapshot=c.start==='from-now'?(roundData(s).snapshots.filter(x=>x.kind==='captured').at(-1)?.id??c.baselineSnapshotId):c.baselineSnapshotId;
      const binding={id:`obs-${prefix}`,projectId:id,repoRoot:c.repoRoot,worktreeRoot:c.worktreeRoot,branch:c.branch,tool:c.format==='codex-exec-jsonl'?'codex-exec' as const:'codex-native' as const,toolVersion:c.toolVersion,taskId:c.taskId,roundId:`round-${prefix}`,attemptId:`attempt-${prefix}`,producerId:`producer-${prefix}`,mode:c.start==='from-now'?'live' as const:'historical-replay' as const,goalHash:c.goalHash,feedbackIds:[],purpose:c.purpose,clauseIds:c.clauseIds,journeyIds:c.journeyIds,selectedActionIds:c.selectedActionIds,acceptedPlan:null,beforeSnapshotId:snapshot,stream:c.stream,deferredBenefit:null};
      this.rounds.enroll(id,binding,true,s);roundId=binding.roundId;
     }
    }else roundId=null;
    c.currentTurnId=turnId;c.currentRoundId=roundId;c.roundSequence=0;
   }
  }
  if(fact.threadId){if(c.threadId&&c.threadId!==fact.threadId)throw new WorkflowError('THREAD_CONFLICT','选定流出现另一会话身份');c.threadId=fact.threadId;}
  if(fact.kind==='delegation'&&fact.parentId===null&&fact.agentId!=='root'){
   fact.parentId=[...d.events].reverse().find(e=>e.connectionId===c.id&&e.kind==='delegation'&&e.agentId===fact.agentId&&e.parentId)?.parentId??null;
  }
  if(fact.agentThreadId&&d.events.some(e=>e.connectionId===c.id&&e.agentId===fact.agentId&&e.agentThreadId&&e.agentThreadId!==fact.agentThreadId))throw new WorkflowError('AGENT_IDENTITY_CONFLICT','子代理路径对应另一线程身份');
  if(fact.kind==='delegation'&&fact.parentId&&fact.parentId!=='root'&&!d.events.some(e=>e.agentId===fact.parentId&&e.connectionId===c.id))throw new WorkflowError('AGENT_PARENT_UNKNOWN','父代理身份未在选定流中观察到；不建立推测层级');
  const children=(fact.children??[]).map(child=>{
   const parentId=child.senderId===c.threadId||child.senderId==='root'?'root':child.senderId;
   if(parentId!=='root'&&!d.events.some(e=>e.agentId===parentId&&e.connectionId===c.id))throw new WorkflowError('AGENT_PARENT_UNKNOWN','协作事件的父代理未在选定流中观察到');
   return {...child,parentId};
  });
  if(c.format==='codex-native-rollout'&&fact.kind==='session')c.metadataVerified=true;
  if(fact.kind==='tool'&&fact.status==='completed'&&fact.itemId){
   const started=[...d.events].reverse().find(e=>e.connectionId===c.id&&e.kind==='tool'&&e.itemId===fact.itemId&&e.status==='started');
   if(started){fact.action=started.action;fact.label=`${started.label}已返回`;}
  }
  if(roundId&&fact.kind!=='session'&&fact.kind!=='ignored'){
   const registration=roundData(s).registrations.find(r=>r.binding.roundId===roundId)!;
   const key=`obs-event-${digest(`${c.id}:${line}`).slice(0,40)}`;
   const existing=roundData(s).events.find(e=>e.event.key===key);
   if(existing&&existing.event.rawHash!==rawHash)throw new WorkflowError('EVENT_CONFLICT','已保存轮次回执与选定流不符');
   const terminal=['turn-complete','turn-failed','turn-cancelled'].includes(fact.kind);
   const snapshot=!existing&&c.start==='from-now'&&(terminal||fact.kind==='tool'&&fact.action==='edit'&&fact.status==='completed')?this.rounds.capture(id,true,s):null;
   const alreadyBegan=roundData(s).events.some(e=>e.event.registrationId===registration.binding.id&&e.event.kind==='begin');
   const kind:RoundEvent['kind']=fact.kind==='turn-start'&&!alreadyBegan?'begin':fact.kind==='turn-complete'?'completed':fact.kind==='turn-cancelled'?'cancelled':fact.kind==='turn-failed'||fact.kind==='error'?'failed':'checkpoint';
   const description:RoundEvent['description']=fact.kind==='turn-start'&&!alreadyBegan?'turn-start':fact.kind==='turn-complete'?'turn-completed':fact.kind==='turn-cancelled'?'cancelled':fact.kind==='turn-failed'||fact.kind==='error'?'turn-failed':fact.kind==='agent-report'?'agent-report-retained-locally':'activity-observed';
   if(!existing)this.rounds.accept(id,{key,projectId:id,registrationId:registration.binding.id,roundId,attemptId:registration.binding.attemptId,producerId:registration.binding.producerId,sequence:registration.cursor+1,dependsOn:[],kind,description,rawHash,observedAt:now(),sourceSnapshotId:snapshot?.id??null},true,s);
   if(terminal)registration.status='terminal';
   c.roundSequence=existing?.event.sequence??registration.cursor;
  }
  const receivedAt=now();
  if(fact.kind==='ignored')c.ignoredCount++;
  else if(!d.events.some(e=>e.id===eventId)){
   d.events.push({id:eventId,connectionId:c.id,line,rawHash,sourceTimestamp:fact.sourceTimestamp,receivedAt,turnId,roundId,agentId:fact.agentId,parentId:fact.parentId,kind:fact.kind,action:fact.action,status:fact.status,label:fact.label,itemId:fact.itemId,sourcePaths:fact.sourcePaths,...(fact.agentThreadId?{agentThreadId:fact.agentThreadId}:{})});
  }
  for(const [index,child] of children.entries()){
   const childId=`${eventId}-child-${index+1}`;
   if(!d.events.some(e=>e.id===childId))d.events.push({id:childId,connectionId:c.id,line,rawHash,sourceTimestamp:fact.sourceTimestamp,receivedAt,turnId,roundId,agentId:child.agentId,parentId:child.parentId,kind:'delegation',action:'delegate',status:child.status,label:'子代理（任务目的未单独提供）',itemId:fact.itemId,sourcePaths:[]});
  }
  c.offset=nextOffset;c.line=line;c.cursor=line;c.prefixHash=nextPrefixHash;c.fileIdentity=identity;c.lastReceivedAt=receivedAt;c.lastCheckedAt=receivedAt;c.status='caught-up';c.issue=null;
  d.revision++;
  return !!roundId&&(children.length>0||['turn-complete','turn-failed','turn-cancelled','delegation','agent-report'].includes(fact.kind));
 }
}
