import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { contained, safePath } from './source.js';
import { projectRounds } from './rounds.js';
import { mainlineIntentSchema, projectMainlineProgress } from './mainline-progress.js';
import { safeId, text, type Project, type Session, type View, WorkflowError } from './types.js';

const streamRef=z.object({rootIndex:z.number().int().nonnegative(),path:text}).strict();
export const activityConnectionSchema=z.object({
 id:safeId,projectId:safeId,repoRoot:text,worktreeRoot:text,branch:text,
 format:z.enum(['codex-exec-jsonl','codex-native-rollout']),toolVersion:text,taskId:safeId,
 goalHash:z.string().regex(/^[a-f0-9]{64}$/),purpose:text,clauseIds:z.array(safeId).min(1).max(100),
 journeyIds:z.array(safeId).max(100),selectedActionIds:z.array(safeId).max(100),
 stream:streamRef,start:z.enum(['from-now','historical-replay']),beforeSnapshotId:safeId.optional(),
 mainlineIntent:mainlineIntentSchema.optional()
}).strict();
export type ActivityConnectionRequest=z.infer<typeof activityConnectionSchema>;
export type ActivityStatus='waiting'|'following'|'caught-up'|'partial-line'|'sync-error'|'unsupported';
export interface ActivityConnection extends ActivityConnectionRequest {
 createdAt:string;offset:number;prefixHash:string;fileIdentity:string|null;line:number;cursor:number;
 status:ActivityStatus;issue:string|null;lastReceivedAt:string|null;lastCheckedAt:string|null;
 currentTurnId:string|null;currentRoundId:string|null;roundSequence:number;threadId:string|null;
 metadataVerified?:boolean;
 baselineSnapshotId:string;ignoredCount:number;history:{kind:'error'|'replay'|'recovered';at:string;issue:string|null;offset:number;cursor:number}[];
}
export type ActivityKind='session'|'turn-start'|'turn-complete'|'turn-failed'|'turn-cancelled'|'tool'|'delegation'|'agent-report'|'error';
export interface ActivityEvent {
 id:string;connectionId:string;line:number;rawHash:string;sourceTimestamp:string|null;receivedAt:string;
 turnId:string|null;roundId:string|null;agentId:string;parentId:string|null;kind:ActivityKind;
 action:'read'|'edit'|'command'|'test'|'tool'|'delegate'|'report'|'turn'|'error';
 status:'started'|'updated'|'waiting'|'interrupted'|'completed'|'failed'|'reported'|'unknown';
 label:string;itemId:string|null;sourcePaths:string[];
 agentThreadId?:string;
}
export interface AgentActivityData {connections:ActivityConnection[];events:ActivityEvent[];revision:number}
export const activityData=(s:Session):AgentActivityData=>s.agentActivity??{connections:[],events:[],revision:0};

export interface DecodedActivity {
 kind:ActivityKind|'ignored';turnId:string|null;threadId:string|null;agentId:string;parentId:string|null;
 action:ActivityEvent['action'];status:ActivityEvent['status'];label:string;itemId:string|null;sourcePaths:string[];sourceTimestamp:string|null;
 children?:{agentId:string;senderId:string;status:ActivityEvent['status']}[];
 cwd?:string;toolVersion?:string;rootTurnId?:string;agentThreadId?:string;emittingThreadId?:string;
}
const object=(x:unknown):Record<string,unknown>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new WorkflowError('STREAM_SCHEMA','事件对象格式无效');return x as Record<string,unknown>;};
const optionalString=(x:unknown)=>typeof x==='string'&&x.length<=300?x:null;
const timestamp=(x:unknown)=>typeof x==='string'&&!Number.isNaN(Date.parse(x))?x:null;
const base=(kind:DecodedActivity['kind'],at:string|null):DecodedActivity=>({kind,turnId:null,threadId:null,agentId:'root',parentId:null,action:'tool',status:'unknown',label:'未分类事件',itemId:null,sourcePaths:[],sourceTimestamp:at});
const itemStatus=(x:unknown,phase:string):ActivityEvent['status']=>{
 if(x==='failed'||x==='error'||x==='declined')return 'failed';
 if(phase==='item.started')return 'started';if(phase==='item.updated')return 'updated';
 if(phase==='item.completed'||x==='completed'||x==='success')return 'completed';return 'unknown';
};
function sourcePaths(project:Project,paths:unknown[]):string[]{
 const allowed:string[]=[];
 for(const value of paths){if(typeof value!=='string'||!value||value.length>2000)continue;
  let path=value;
  if(path.startsWith(project.sourceRoot+'/'))path=relative(project.sourceRoot,path);
  if(path.split('/').some(part=>['.git','node_modules','.codex','.agents'].includes(part)))continue;
  try{const full=safePath(project.sourceRoot,path);if(project.scope.some(scope=>contained(resolve(project.sourceRoot,scope),full))&&!project.exclude?.some(scope=>contained(resolve(project.sourceRoot,scope),full)))allowed.push(path);}catch{/* A path outside registered source remains unmapped. */}
 }
 return [...new Set(allowed)].slice(0,30);
}
function parseArguments(x:unknown):Record<string,unknown>{if(typeof x!=='string'||x.length>200000)throw new WorkflowError('STREAM_SCHEMA','工具参数格式无效');try{return object(JSON.parse(x));}catch{throw new WorkflowError('STREAM_SCHEMA','工具参数 JSON 无效');}}
function childStatus(value:unknown):ActivityEvent['status']{
 const status=typeof value==='object'&&value!==null?(value as Record<string,unknown>).status:value;
 if(status==='completed')return 'completed';if(status==='errored'||status==='failed')return 'failed';
 if(status==='interrupted')return 'interrupted';if(status==='pendingInit'||status==='pending_init')return 'waiting';
 if(status==='running')return 'started';return 'unknown';
}
export function decodeCodexActivity(format:ActivityConnectionRequest['format'],raw:unknown,project:Project):DecodedActivity{
 const x=object(raw),type=x.type;if(typeof type!=='string')throw new WorkflowError('STREAM_SCHEMA','事件类型缺失');
 const at=timestamp(x.timestamp);
 if(format==='codex-exec-jsonl'){
  const d=base('ignored',at);
  if(type==='thread.started'){const thread=optionalString(x.thread_id);if(!thread)throw new WorkflowError('STREAM_SCHEMA','thread.started 缺 thread_id');return {...d,kind:'session',threadId:thread,action:'turn',label:'Codex 会话开始'};}
  if(type==='turn.started')return {...d,kind:'turn-start',turnId:optionalString(x.turn_id),action:'turn',status:'started',label:'开发轮次开始'};
  if(type==='turn.completed'||type==='turn.failed')return {...d,kind:type==='turn.completed'?'turn-complete':'turn-failed',turnId:optionalString(x.turn_id),action:'turn',status:type==='turn.completed'?'completed':'failed',label:type==='turn.completed'?'主代理本轮报告完成':'主代理本轮失败'};
  if(type==='error')return {...d,kind:'error',action:'error',status:'failed',label:'Codex 报告错误'};
  if(!['item.started','item.updated','item.completed'].includes(type))throw new WorkflowError('STREAM_SCHEMA',`未支持的 Codex exec 事件类型 ${type}`);
  const item=object(x.item),itemType=item.type,itemId=optionalString(item.id);if(!itemId||typeof itemType!=='string')throw new WorkflowError('STREAM_SCHEMA','item 缺少 id 或 type');
  if(!['command_execution','file_change','agent_message','reasoning','mcp_tool_call','web_search','todo_list','error','collab_tool_call','collab_agent_tool_call','collabAgentToolCall','subAgentActivity'].includes(itemType))throw new WorkflowError('STREAM_SCHEMA',`未支持的 Codex item 类型 ${itemType}`);
  if(itemType==='reasoning'||itemType==='todo_list')return d;
  if(itemType==='agent_message')return type==='item.completed'?{...d,kind:'agent-report',action:'report',status:'reported',itemId,label:'主代理报告（未经产品验证）'}:d;
  if(itemType==='error')return {...d,kind:'error',action:'error',status:'failed',itemId,label:'工具错误'};
  if(itemType==='subAgentActivity'){
   const agentId=optionalString(item.agentThreadId),path=optionalString(item.agentPath),kind=item.kind;
   if(!agentId||!path||!['started','interacted','interrupted','completed'].includes(String(kind)))throw new WorkflowError('STREAM_SCHEMA','子代理活动身份或状态无效');
   return {...d,kind:'delegation',agentId,parentId:null,action:'delegate',status:kind==='completed'?'completed':kind==='interrupted'?'interrupted':kind==='started'?'started':'updated',itemId,label:'子代理活动'};
  }
  if(['collab_tool_call','collab_agent_tool_call','collabAgentToolCall'].includes(itemType)){
   // Current protocol carries sender/receiver thread IDs and each child's
   // agents_states. A completed tool call is not a completed child.
   const sender=optionalString(item.sender_thread_id)??optionalString(item.senderThreadId);
   const receivers=Array.isArray(item.receiver_thread_ids)?item.receiver_thread_ids:Array.isArray(item.receiverThreadIds)?item.receiverThreadIds:null;
   const states=item.agents_states??item.agentsStates;
   if(sender&&receivers){if(receivers.length>30||receivers.some(v=>!optionalString(v)))throw new WorkflowError('STREAM_SCHEMA','协作接收者身份无效');
    const mapped=states&&typeof states==='object'&&!Array.isArray(states)?states as Record<string,unknown>:{};
    return {...d,kind:'tool',action:'tool',status:itemStatus(item.status,type),itemId,label:'代理协作工具',children:receivers.map(v=>({agentId:v as string,senderId:sender,status:childStatus(mapped[v as string])}))};
   }
   const receiver=optionalString(item.receiver)??optionalString(item.recipient),fallbackSender=optionalString(item.sender)??'root';
   return {...d,kind:receiver?'delegation':'tool',agentId:receiver??'root',parentId:receiver?fallbackSender:null,action:receiver?'delegate':'tool',status:'unknown',itemId,label:receiver?'代理协作调用（子状态未知）':'协作工具（目标未报告）'};
  }
  const action=itemType==='file_change'?'edit':itemType==='command_execution'?'command':'tool';
  const changes=Array.isArray(item.changes)?item.changes:[];
  return {...d,kind:'tool',action,status:typeof item.exit_code==='number'&&item.exit_code!==0?'failed':itemStatus(item.status,type),itemId,label:itemType==='file_change'?'文件修改':itemType==='command_execution'?'命令执行':'工具调用',sourcePaths:itemType==='file_change'?sourcePaths(project,changes.map(c=>c&&typeof c==='object'?(c as Record<string,unknown>).path:null)):[]};
 }
 // Native rollout is an explicitly selected single transcript. The fields below
 // are based on observed session_meta / turn_context / response_item records.
 const payload=object(x.payload);const d=base('ignored',at);
 if(type==='session_meta'){
  const thread=optionalString(payload.id)??optionalString(payload.session_id),cwd=optionalString(payload.cwd),toolVersion=optionalString(payload.cli_version);
  if(!thread||!cwd||!toolVersion)throw new WorkflowError('IDENTITY_UNRESOLVED','session_meta 缺会话身份、工作目录或版本');
  return {...d,kind:'session',threadId:thread,cwd,toolVersion,action:'turn',label:'Codex 会话元数据'};
 }
 if(type==='turn_context'){
  const turn=optionalString(payload.turn_id),cwd=optionalString(payload.cwd),rootTurnId=optionalString(payload.root_turn_id);
  if(!turn||!cwd||!rootTurnId)throw new WorkflowError('IDENTITY_UNRESOLVED','turn_context 缺轮次、工作目录或根轮次身份');
  return {...d,kind:'turn-start',turnId:turn,cwd,rootTurnId,action:'turn',status:'started',label:'开发轮次上下文'};
 }
 if(type==='event_msg'){
  // task_started precedes turn_context in the native stream. The latter is
  // required before a project-bound round can be established.
  if(payload.type==='task_started'){
   const turn=optionalString(payload.turn_id),root=optionalString(payload.root_turn_id);
   if(!turn||!root||turn!==root)throw new WorkflowError('IDENTITY_UNRESOLVED','task_started 缺失或混入另一根轮次');
   return {...d,turnId:turn,rootTurnId:root};
  }
  if(payload.type==='task_complete'){const turn=optionalString(payload.turn_id);if(!turn)throw new WorkflowError('STREAM_SCHEMA','task_complete 缺 turn_id');return {...d,kind:'turn-complete',turnId:turn,action:'turn',status:'completed',label:'主代理本轮报告完成'};}
  if(payload.type==='turn_aborted')return {...d,kind:'turn-cancelled',turnId:optionalString(payload.turn_id),action:'turn',status:'interrupted',label:'本轮已中止'};
  if(payload.type==='item_completed'){
   const item=object(payload.item),itemType=item.type,itemId=optionalString(item.id);
   if(!itemId||typeof itemType!=='string')throw new WorkflowError('STREAM_SCHEMA','item_completed 缺项目身份或类型');
   if(itemType==='SubAgentActivity'){
    const path=optionalString(item.agent_path),thread=optionalString(item.agent_thread_id),kind=item.kind;
    if(!path||!/^\/root(?:\/[A-Za-z0-9._-]+)+$/.test(path)||!thread||!['started','interacted','completed','interrupted'].includes(String(kind)))throw new WorkflowError('STREAM_SCHEMA','子代理活动身份或状态无效');
    const parent=path.slice(0,path.lastIndexOf('/'));
    return {...d,kind:'delegation',agentId:path,parentId:parent==='/root'?'root':parent,agentThreadId:thread,emittingThreadId:optionalString(payload.thread_id)??undefined,action:'delegate',status:kind==='completed'?'completed':kind==='interrupted'?'interrupted':kind==='started'?'started':'updated',itemId,label:`任务标记：${path.split('/').at(-1)}`};
   }
   if(itemType==='CollabAgentToolCall')return {...d,kind:'tool',emittingThreadId:optionalString(payload.thread_id)??undefined,action:'tool',status:itemStatus(item.status,'item.completed'),itemId,label:'代理协作工具'};
   if(itemType==='CommandExecution')return {...d,kind:'tool',emittingThreadId:optionalString(payload.thread_id)??undefined,action:'command',status:typeof item.exit_code==='number'&&item.exit_code!==0?'failed':itemStatus(item.status,'item.completed'),itemId,label:'命令执行'};
   return d;
  }
  return d;
 }
 if(type==='response_item'){
  if(payload.type==='agent_message'){
   const author=optionalString(payload.author)??'unknown';return {...d,kind:'agent-report',agentId:author,parentId:author==='root'?null:'root',action:'report',status:'reported',itemId:optionalString(payload.id),label:'代理报告（未经产品验证）'};
  }
  if(payload.type==='function_call'||payload.type==='custom_tool_call'){
   const name=optionalString(payload.name),namespace=optionalString(payload.namespace),itemId=optionalString(payload.call_id)??optionalString(payload.id);
   if(!name||!itemId)throw new WorkflowError('STREAM_SCHEMA','工具调用缺 name 或 call_id');
   if(namespace==='collaboration'&&name==='spawn_agent'){
    const args=parseArguments(payload.arguments),task=optionalString(args.task_name);if(!task)throw new WorkflowError('STREAM_SCHEMA','spawn_agent 缺 task_name');
    if(!/^[A-Za-z0-9._-]+$/.test(task))throw new WorkflowError('STREAM_SCHEMA','spawn_agent 任务标记无效');
    const child=`/root/${task}`;return {...d,kind:'delegation',agentId:child,parentId:'root',action:'delegate',status:'started',itemId,label:`任务标记：${task}`};
   }
   const action=name==='apply_patch'?'edit':name==='exec_command'?'command':'tool';
   return {...d,kind:'tool',action,status:'started',itemId,label:action==='edit'?'文件修改':action==='command'?'命令执行':'工具调用'};
  }
  if(payload.type==='function_call_output'||payload.type==='custom_tool_call_output'){
   const itemId=optionalString(payload.call_id);if(!itemId)throw new WorkflowError('STREAM_SCHEMA','工具返回缺 call_id');
   return {...d,kind:'tool',action:'tool',status:'completed',itemId,label:'工具调用已返回'};
  }
  return d;
 }
 if(['token_usage_record','world_state','inter_agent_communication_metadata','compacted'].includes(type))return d;
 throw new WorkflowError('STREAM_SCHEMA',`未支持的 Codex rollout 事件类型 ${type}`);
}

export function projectActivity(s:Session,currentSourceHash?:string,mainline?:ReturnType<typeof projectMainlineProgress>){
 const data=activityData(s),goal=s.goals.at(-1),rounds=s.rounds;
 const roundProjection=currentSourceHash?projectRounds(s,undefined,currentSourceHash):null;
 const shared=mainline??(currentSourceHash?projectMainlineProgress(s,currentSourceHash,roundProjection!):null);
 const turns=data.events.filter(e=>e.kind==='turn-start').reduce((map,e)=>{if(e.turnId){const key=`${e.connectionId}:${e.turnId}`;if(!map.has(key))map.set(key,e);}return map;},new Map<string,ActivityEvent>());
 const projected=[...turns.values()].map(start=>{
  const turnId=start.turnId!;
  const events=data.events.filter(e=>e.connectionId===start.connectionId&&e.turnId===turnId),end=[...events].reverse().find(e=>e.kind==='turn-complete'||e.kind==='turn-failed');
  const children=new Map<string,{id:string;parentId:string|null;label:string;status:'delegated'|'reported'|'waiting'|'interrupted'|'completed'|'failed'|'unknown';lastAction:string|null}>();
  for(const e of events){if(e.kind==='delegation'&&e.agentId!=='root'){
    const previous=children.get(e.agentId);
    children.set(e.agentId,{id:e.agentId,parentId:e.parentId??previous?.parentId??null,label:previous?.label??e.label,status:e.status==='completed'?'completed':e.status==='failed'?'failed':e.status==='interrupted'?'interrupted':e.status==='waiting'?'waiting':'delegated',lastAction:e.label});}
   if(e.kind==='agent-report'&&e.agentId!=='root'){const child=children.get(e.agentId);if(child){if(!['completed','failed'].includes(child.status))child.status='reported';child.lastAction='已报告结果；独立验证仍需核对';}else children.set(e.agentId,{id:e.agentId,parentId:null,label:'来源未定位的代理',status:'unknown',lastAction:'仅收到报告'});}}
  const last=events.at(-1),conn=data.connections.find(c=>c.id===start.connectionId),roundId=start.roundId;
  const round=rounds?.registrations.find(r=>r.binding.roundId===roundId),snap=rounds?.snapshots.find(x=>x.id===round?.binding.beforeSnapshotId);
  const view=currentSourceHash?[...s.views].reverse().find((v:View)=>v.goal?.hash===conn?.goalHash&&v.source.hash===currentSourceHash):undefined;
  const paths=[...new Set(events.flatMap(e=>e.sourcePaths))],targets=view?[...view.analysis.modules,...view.analysis.edges].filter(t=>t.refs.some(ref=>paths.includes(ref.path))).map(t=>({id:t.id,label:'title' in t?t.title:t.label})):[];
  const roundState=roundProjection?.rounds.find(r=>r.id===roundId),mainlineRound=shared?.rounds.find(r=>r.roundId===roundId);
  const proof=mainlineRound?.steps.flatMap(step=>step.conditions).filter(c=>c.result==='passed').length??0;
  const boundGoal=s.goals.find(g=>g.hash===conn?.goalHash);
  const goalClauses=(conn?.clauseIds??[]).map(id=>boundGoal?.clauses.find(c=>c.id===id)).filter((c):c is NonNullable<typeof c>=>!!c).map(c=>({id:c.id,text:c.text}));
  return {turnId,roundId,connectionId:start.connectionId,taskId:conn?.taskId??null,purpose:conn?.purpose??'目的未登记',goalHash:conn?.goalHash??null,goalClauses,stale:conn?.goalHash!==goal?.hash,
   status:events.some(e=>e.kind==='turn-cancelled')?'cancelled':end?.kind==='turn-failed'?'failed':end&&[...children.values()].some(c=>c.status==='failed'||c.status==='interrupted')?'child-failed':end&&[...children.values()].some(c=>c.status!=='completed')?'child-unknown':end?'parent-reported-complete':'observing',
   sourceTiming:conn?.start==='historical-replay'?'历史回放；当前来源不归因于旧事件':'从连接时开始观察',beforeSnapshotId:snap?.id??null,
   latestEventAt:last?.sourceTimestamp??null,lastReceivedAt:last?.receivedAt??null,latestEvent:last?.label??null,sourceStale:roundState?.sourceStale??null,currentAction:[...events].reverse().find(e=>e.kind==='tool')?.label??null,
   agents:[{id:'root',parentId:null,label:'主代理',status:events.some(e=>e.kind==='turn-cancelled')?'interrupted':end?.kind==='turn-failed'?'failed':end?'reported':'observing',lastAction:[...events].reverse().find(e=>e.agentId==='root'&&e.kind==='tool')?.label??null},...children.values()],
   childInternalTraceObserved:events.some(e=>e.agentId!=='root'&&e.kind==='tool'),
   sourcePaths:paths,targets,mainline:mainlineRound??null,verified:proof>0,passedConditions:proof,eventCount:events.length};
 });
 return {revision:data.revision,connections:data.connections.map(c=>({id:c.id,format:c.format,toolVersion:c.toolVersion,stream:{rootIndex:c.stream.rootIndex,path:c.stream.path},taskId:c.taskId,purpose:c.purpose,goalHash:c.goalHash,status:c.status,issue:c.issue,offset:c.offset,cursor:c.cursor,lastReceivedAt:c.lastReceivedAt,lastCheckedAt:c.lastCheckedAt,ignoredCount:c.ignoredCount,start:c.start,identityEvidence:c.format==='codex-exec-jsonl'?'declared-launch':c.metadataVerified?'native-attested':'pending-native-metadata',relevance:c.goalHash===goal?.hash?'bound to current goal':'reconfirm purpose for changed goal',coverage:'仅观察选定流；追上文件末尾或暂时无事件不证明生产者仍在线或已经完成'})),turns:projected,chronology:data.events.slice(-100).map(e=>({id:e.id,turnId:e.turnId,roundId:e.roundId,kind:e.kind,action:e.action,status:e.status,label:e.label,agentId:e.agentId,sourceTimestamp:e.sourceTimestamp,receivedAt:e.receivedAt,rawHash:e.rawHash,sourcePaths:e.sourcePaths}))};
}
