import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { projectActivity } from '../../src/core/human-goal-workflow/agent-activity.js';
import { projectRounds } from '../../src/core/human-goal-workflow/rounds.js';
import { digest, hash } from '../../src/core/human-goal-workflow/types.js';

let root:string, source:string, evidence:string, config:any, service:HumanGoalService;
const line=(value:unknown)=>JSON.stringify(value)+'\n';
const model={revision:'fixture-only',async analyze(){throw new Error('model is not used by observer');}};
const nativeMeta=()=>({type:'session_meta',timestamp:'2026-09-23T00:00:00Z',payload:{id:'session-a',cwd:source,cli_version:'0.155.0-alpha.9.2'}});
const nativeStart=(turn:string)=>({type:'event_msg',timestamp:'2026-09-23T00:00:01Z',payload:{type:'task_started',turn_id:turn,root_turn_id:turn}});
const nativeContext=(turn:string)=>({type:'turn_context',timestamp:'2026-09-23T00:00:01Z',payload:{turn_id:turn,root_turn_id:turn,cwd:source}});
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'agent-activity-'));source=join(root,'source');evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);
 writeFileSync(join(source,'main.ts'),'export const main = 1;\n');writeFileSync(join(evidence,'selected.jsonl'),'');
 config={projects:[{id:'self',label:'fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 service=new HumanGoalService(config,model as any,{dispatchRoundAnalysis:false});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'See agents and proof',author:'test',provenance:'fixture',clauses:[{id:'goal',text:'See agents and proof',importance:'core'}],analyze:false});
});
afterEach(async()=>{vi.restoreAllMocks();await service.close();rmSync(root,{recursive:true,force:true});});
function connect(format:'codex-native-rollout'|'codex-exec-jsonl'='codex-native-rollout',id='connection',path='selected.jsonl'){
 const s=service.read('self');return service.activity.connect('self',{id,projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format,toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:s.goals.at(-1)!.hash,purpose:'Observe this development task',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path},start:'from-now'});
}
it('follows native turn identities, keeps child reports separate from proof, and survives restart without copies',async()=>{
 connect();const path=join(evidence,'selected.jsonl');
 appendFileSync(path,[
  nativeMeta(),nativeStart('turn-a'),nativeContext('turn-a'),
  {type:'response_item',timestamp:'2026-09-23T00:00:02Z',payload:{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'call-1',arguments:JSON.stringify({task_name:'research',message:'SECRET delegated work'})}},
  {type:'response_item',timestamp:'2026-09-23T00:00:03Z',payload:{type:'agent_message',author:'/root/research',recipient:'/root',content:[{text:'SECRET fixed everything'}]}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:04Z',payload:{type:'task_complete',turn_id:'turn-a'}},
 ].map(line).join(''));
 service.activity.poll('self','connection');let s=service.read('self'),p=projectActivity(s);
 expect(p.turns).toHaveLength(1);expect(p.turns[0].status).toBe('child-unknown');expect(p.turns[0].goalClauses).toEqual([{id:'goal',text:'See agents and proof'}]);expect(p.turns[0].agents.some(a=>a.parentId==='root'&&a.status==='reported')).toBe(true);
 expect(projectRounds(s).rounds[0].status).not.toBe('completed');expect(JSON.stringify(s.agentActivity)).not.toContain('SECRET');
 expect(p.turns[0].verified).toBe(false);
 const stateHash=hash(s);service.activity.poll('self','connection');expect(hash(service.read('self'))).toBe(stateHash);
 await service.close();service=new HumanGoalService(config,model as any,{dispatchRoundAnalysis:false});service.activity.poll('self','connection');expect(hash(service.read('self'))).toBe(stateHash);
 appendFileSync(path,[nativeStart('turn-b'),nativeContext('turn-b'),{type:'event_msg',timestamp:'2026-09-23T00:00:06Z',payload:{type:'task_complete',turn_id:'turn-b'}}].map(line).join(''));
 service.activity.poll('self','connection');expect(projectActivity(service.read('self')).turns).toHaveLength(2);
});
it('retains partial lines, cursor and errors for changed or malformed selected streams',()=>{
 connect('codex-exec-jsonl');const path=join(evidence,'selected.jsonl');appendFileSync(path,'{"type":"thread.started","thread_id":"thread-a"');
 expect(service.activity.poll('self','connection').status).toBe('partial-line');expect(projectActivity(service.read('self')).turns).toHaveLength(0);
 appendFileSync(path,'}\n'+line({type:'turn.started'}));const followed=service.activity.poll('self','connection');expect(followed.status).toBe('caught-up');expect(projectActivity(service.read('self')).turns).toHaveLength(1);
 const before=service.read('self').agentActivity!.connections[0];writeFileSync(path,readFileSync(path,'utf8').replace('thread-a','thread-b'));
 expect(service.activity.poll('self','connection').issue).toContain('STREAM_CHANGED');const after=service.read('self').agentActivity!.connections[0];expect(after.offset).toBe(before.offset);expect(after.cursor).toBe(before.cursor);
});
it('rejects unsafe scope, stale goal and false historical baseline; goal changes require reconfirmation',()=>{
 const req={id:'bad',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format:'codex-native-rollout',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:service.read('self').goals[0].hash,purpose:'task',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path:'../escape'},start:'from-now'};
 expect(()=>service.activity.connect('self',req)).toThrow();expect(()=>service.activity.connect('self',{...req,stream:{rootIndex:0,path:'selected.jsonl'},start:'historical-replay'})).toThrow();
 connect();let s=service.read('self');service.feedback('self',{expectedGeneration:s.generation,idempotencyKey:'goal-2',kind:'desired-change',originalText:'Changed goal',author:'test',provenance:'fixture',analyze:false});
 appendFileSync(join(evidence,'selected.jsonl'),[nativeMeta(),nativeStart('turn-after-goal'),nativeContext('turn-after-goal')].map(line).join(''));service.activity.poll('self','connection');
 expect(projectActivity(service.read('self')).connections[0].relevance).toContain('reconfirm');expect(projectActivity(service.read('self')).turns[0].roundId).toBeNull();
});
it('keeps a pre-event baseline when polling is delayed and maps only safe file-change paths',()=>{
 connect('codex-exec-jsonl');const path=join(evidence,'selected.jsonl');writeFileSync(join(source,'main.ts'),'export const main = 2;\n');
 appendFileSync(path,[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'item.completed',item:{id:'edit-1',type:'file_change',status:'completed',changes:[{path:'main.ts'},{path:'../private/key'}]}},{type:'turn.completed'}].map(line).join(''));
 service.activity.poll('self','connection');const s=service.read('self'),round=projectRounds(s).rounds[0],turn=projectActivity(s).turns[0];
 expect(round.deltas).toMatchObject([{path:'main.ts',kind:'modified'}]);expect(turn.sourcePaths).toEqual(['main.ts']);expect(turn.verified).toBe(false);
 expect(JSON.stringify(s.agentActivity)).not.toContain('../private/key');
});
it('rejects a second id-less exec turn and an unknown delegation parent without advancing the failing line',()=>{
 connect('codex-exec-jsonl');const path=join(evidence,'selected.jsonl');appendFileSync(path,[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'turn.completed'},{type:'turn.started'}].map(line).join(''));
 const first=service.activity.poll('self','connection');expect(first.issue).toContain('TURN_ID_REQUIRED');expect(first.cursor).toBe(3);
 service.activity.replay('self','connection');expect(service.activity.poll('self','connection').cursor).toBe(3);
});
it('refuses a child edge whose parent was not observed in the selected stream',()=>{
 connect('codex-exec-jsonl');appendFileSync(join(evidence,'selected.jsonl'),[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'item.started',item:{id:'child-1',type:'collab_tool_call',sender:'missing-parent',receiver:'child'}}].map(line).join(''));
 const failed=service.activity.poll('self','connection');expect(failed.issue).toContain('AGENT_PARENT_UNKNOWN');expect(failed.cursor).toBe(2);expect(projectActivity(service.read('self')).turns[0].agents).toHaveLength(1);
});
it('records malformed and rotated selected streams as recoverable errors without erasing accepted events',()=>{
 connect();const path=join(evidence,'selected.jsonl'),initial=[nativeMeta(),nativeStart('turn-a'),nativeContext('turn-a')].map(line).join('');appendFileSync(path,initial);
 service.activity.poll('self','connection');const before=service.read('self').agentActivity!.events.length;
 appendFileSync(path,'{invalid}\n');const failed=service.activity.poll('self','connection');expect(failed.issue).toContain('STREAM_SCHEMA');expect(service.read('self').agentActivity!.events).toHaveLength(before);
 writeFileSync(path,initial+line({type:'event_msg',timestamp:'2026-09-23T00:00:01Z',payload:{type:'task_complete',turn_id:'turn-a'}}));
 expect(service.activity.replay('self','connection').status).toBe('caught-up');expect(service.read('self').agentActivity!.connections[0].history.map(x=>x.kind)).toEqual(['error','replay','recovered']);
 renameSync(path,join(evidence,'old.jsonl'));writeFileSync(path,'');expect(service.activity.poll('self','connection').issue).toContain('STREAM_ROTATED');
});
it('queues existing round analysis only after a complete observed turn with no unresolved child',async()=>{
 await service.close();config.roundAnalysis={enabled:true,historical:false};service=new HumanGoalService(config,model as any,{dispatchRoundAnalysis:false});connect();
 appendFileSync(join(evidence,'selected.jsonl'),[nativeMeta(),nativeStart('turn-complete'),nativeContext('turn-complete'),{type:'event_msg',timestamp:'2026-09-23T00:00:01Z',payload:{type:'task_complete',turn_id:'turn-complete'}}].map(line).join(''));
 service.activity.poll('self','connection');expect(service.read('self').roundAnalysis?.jobs).toHaveLength(1);expect(service.read('self').roundAnalysis?.jobs[0].state).toBe('pending');
 const before=service.read('self').roundAnalysis?.jobs.length;service.activity.poll('self','connection');expect(service.read('self').roundAnalysis?.jobs.length).toBe(before);
});
it('uses explicit current Codex collaboration agent states, not a completed tool call, for child completion',()=>{
 connect('codex-exec-jsonl');const path=join(evidence,'selected.jsonl');const collab=(status:string,child:string)=>({id:'call-1',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'thread-a',receiverThreadIds:['child-a'],agentsStates:{'child-a':{status:child}},status,prompt:'SECRET delegated prompt'});
 appendFileSync(path,[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'item.started',item:collab('in_progress','running')},{type:'item.completed',item:collab('completed','running')},{type:'turn.completed'}].map(line).join(''));
 service.activity.poll('self','connection');let s=service.read('self');expect(projectActivity(s).turns[0].status).toBe('child-unknown');expect(projectRounds(s).rounds[0].status).toBe('agent-unknown');expect(JSON.stringify(s.agentActivity)).not.toContain('SECRET');
 appendFileSync(path,line({type:'item.updated',item:collab('completed','completed')}));service.activity.poll('self','connection');s=service.read('self');expect(projectActivity(s).turns[0].status).toBe('parent-reported-complete');expect(projectRounds(s).rounds[0].status).toBe('completed');
});
it('links a current protocol subagent activity completion to the observed delegation',()=>{
 connect('codex-exec-jsonl');const path=join(evidence,'selected.jsonl');
 appendFileSync(path,[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},
  {type:'item.completed',item:{id:'collab-1',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'thread-a',receiverThreadIds:['child-a'],agentsStates:{'child-a':{status:'running'}},status:'completed'}},
  {type:'turn.completed'},
  {type:'item.completed',item:{id:'activity-1',type:'subAgentActivity',agentPath:'/root/child',agentThreadId:'child-a',kind:'completed'}}].map(line).join(''));
 service.activity.poll('self','connection');const s=service.read('self'),turn=projectActivity(s).turns[0];
 expect(turn.agents.find(a=>a.id==='child-a')).toMatchObject({parentId:'root',status:'completed'});
 expect(turn.status).toBe('parent-reported-complete');expect(projectRounds(s).rounds[0].status).toBe('completed');
});
it('atomically retries a crash after begin enrollment without duplicate registration or receipt',()=>{
 connect('codex-exec-jsonl');appendFileSync(join(evidence,'selected.jsonl'),[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'turn.completed'}].map(line).join(''));
 const save=service.store.save.bind(service.store);let injected=false;
 vi.spyOn(service.store,'save').mockImplementation(s=>{if(!injected&&s.agentActivity?.events.some(e=>e.kind==='turn-start')){injected=true;throw Error('crash before atomic pointer update');}return save(s);});
 const first=service.activity.poll('self','connection');expect(injected).toBe(true);expect(first.status).toBe('sync-error');expect(first.cursor).toBe(1);expect(service.read('self').rounds?.registrations).toHaveLength(0);
 vi.restoreAllMocks();const recovered=service.activity.replay('self','connection'),s=service.read('self');
 expect(recovered.status).toBe('caught-up');expect(recovered.cursor).toBe(3);expect(s.rounds?.registrations).toHaveLength(1);
 expect(s.rounds?.events.map(e=>e.event.kind)).toEqual(['begin','completed']);expect(s.rounds?.conflicts).toHaveLength(0);
});
it('reuses an exact legacy receipt when activity and cursor were not saved',()=>{
 connect('codex-exec-jsonl');const records=[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},{type:'turn.completed'}],path=join(evidence,'selected.jsonl');
 appendFileSync(path,records.map(line).join(''));service.activity.poll('self','connection');
 const s=service.read('self'),before=s.rounds!.events.map(e=>e.payloadHash),prefix=records.slice(0,2).map(line).join(''),c=s.agentActivity!.connections[0];
 s.agentActivity!.events=s.agentActivity!.events.filter(e=>e.kind!=='turn-complete');c.offset=Buffer.byteLength(prefix);c.prefixHash=digest(prefix);c.line=2;c.cursor=2;c.status='sync-error';c.issue='legacy split write';
 service.store.save(s);const recovered=service.activity.replay('self','connection'),after=service.read('self');
 expect(recovered.status).toBe('caught-up');expect(after.rounds!.events.map(e=>e.payloadHash)).toEqual(before);expect(after.rounds!.conflicts).toHaveLength(0);
 expect(after.agentActivity!.events.filter(e=>e.kind==='turn-complete')).toHaveLength(1);
});
it('records native tool output and cancellation without leaving a working round',()=>{
 connect();const records=[nativeMeta(),nativeStart('turn-a'),nativeContext('turn-a'),
  {type:'response_item',timestamp:'2026-09-23T00:00:02Z',payload:{type:'function_call',name:'exec_command',call_id:'call-a',arguments:'{}'}},
  {type:'response_item',timestamp:'2026-09-23T00:00:03Z',payload:{type:'function_call_output',call_id:'call-a',output:'SECRET raw output'}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:04Z',payload:{type:'turn_aborted',turn_id:'turn-a'}}];
 appendFileSync(join(evidence,'selected.jsonl'),records.map(line).join(''));service.activity.poll('self','connection');const s=service.read('self');
 expect(projectActivity(s).turns[0].status).toBe('cancelled');expect(projectRounds(s).rounds[0].status).toBe('cancelled');
 expect(s.agentActivity!.events.find(e=>e.itemId==='call-a'&&e.status==='completed')).toMatchObject({action:'command',label:'命令执行已返回'});
 expect(JSON.stringify(s.agentActivity)).not.toContain('SECRET');
});
it('separates identical turn IDs from two explicitly selected connections',()=>{
 writeFileSync(join(evidence,'second.jsonl'),'');connect('codex-exec-jsonl');connect('codex-exec-jsonl','connection-two','second.jsonl');
 for(const path of ['selected.jsonl','second.jsonl'])appendFileSync(join(evidence,path),[{type:'thread.started',thread_id:path},{type:'turn.started',turn_id:'same-turn'},{type:'turn.completed',turn_id:'same-turn'}].map(line).join(''));
 service.activity.poll('self','connection');service.activity.poll('self','connection-two');const s=service.read('self'),activity=projectActivity(s);
 expect(activity.turns).toHaveLength(2);expect(new Set(activity.turns.map(t=>t.roundId)).size).toBe(2);
 expect(projectRounds(s).rounds).toHaveLength(2);
});
it('revalidates an already consumed native header when an older connection lacks the metadata flag',()=>{
 const path=join(evidence,'selected.jsonl');writeFileSync(path,line(nativeMeta()));connect();const s=service.read('self');delete s.agentActivity!.connections[0].metadataVerified;service.store.save(s);
 appendFileSync(path,[nativeStart('turn-a'),nativeContext('turn-a'),{type:'event_msg',timestamp:'2026-09-23T00:00:03Z',payload:{type:'task_complete',turn_id:'turn-a'}}].map(line).join(''));
 const followed=service.activity.poll('self','connection');expect(followed.status).toBe('caught-up');expect(followed.metadataVerified).toBe(true);
 expect(projectActivity(service.read('self')).turns).toHaveLength(1);
});
it('uses observed native SubAgentActivity completion separately from product verification',()=>{
 connect();const turn='turn-a',child='/root/agent_activity_witness',records=[nativeMeta(),nativeStart(turn),nativeContext(turn),
  {type:'response_item',timestamp:'2026-09-23T00:00:02Z',payload:{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'spawn',arguments:JSON.stringify({task_name:'agent_activity_witness',message:'SECRET task body'})}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:03Z',payload:{type:'item_completed',thread_id:'session-a',turn_id:turn,item:{type:'SubAgentActivity',id:'spawn',kind:'started',agent_thread_id:'child-a',agent_path:child}}},
  {type:'response_item',timestamp:'2026-09-23T00:00:04Z',payload:{type:'agent_message',author:child,recipient:'/root',content:'SECRET report'}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:05Z',payload:{type:'item_completed',thread_id:'session-a',turn_id:turn,item:{type:'SubAgentActivity',id:'child-completed',kind:'completed',agent_thread_id:'child-a',agent_path:child}}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:06Z',payload:{type:'task_complete',turn_id:turn}}];
 appendFileSync(join(evidence,'selected.jsonl'),records.map(line).join(''));service.activity.poll('self','connection');const s=service.read('self'),activity=projectActivity(s);
 expect(activity.turns[0].status).toBe('parent-reported-complete');expect(activity.turns[0].agents.find(a=>a.id===child)).toMatchObject({parentId:'root',status:'completed',label:'任务标记：agent_activity_witness'});
 expect(activity.turns[0].childInternalTraceObserved).toBe(false);expect(activity.turns[0].verified).toBe(false);
 expect(projectRounds(s).rounds[0].status).toBe('completed');expect(JSON.stringify(s.agentActivity)).not.toContain('SECRET');
});
it('bounds synchronous poll work, coalesces ignored lines, and leaves idle state unwritten',()=>{
 connect('codex-exec-jsonl');const records=[{type:'thread.started',thread_id:'thread-a'},{type:'turn.started'},
  ...Array.from({length:110},(_,i)=>({type:'item.completed',item:{id:`reason-${i}`,type:'reasoning',text:'SECRET thought'}})),
  ...Array.from({length:20},(_,i)=>({type:'item.started',item:{id:`tool-${i}`,type:'command_execution'}}))];
 appendFileSync(join(evidence,'selected.jsonl'),records.map(line).join(''));
 const dir=join(config.dataDir,'sessions','self'),before=readdirSync(dir).length,first=service.activity.poll('self','connection');
 expect(first.status).toBe('following');expect(first.cursor).toBeLessThanOrEqual(64);expect(readdirSync(dir).length-before).toBeLessThanOrEqual(5);
 let result=first;for(let i=0;i<30&&result.status==='following';i++)result=service.activity.poll('self','connection');
 expect(result.status).toBe('caught-up');expect(result.cursor).toBe(records.length);expect(service.read('self').agentActivity!.events).toHaveLength(22);
 const count=readdirSync(dir).length,stateHash=hash(service.read('self'));service.activity.poll('self','connection');
 expect(readdirSync(dir)).toHaveLength(count);expect(hash(service.read('self'))).toBe(stateHash);
});
