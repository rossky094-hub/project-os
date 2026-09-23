import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Server } from 'node:http';
import { Readable } from 'node:stream';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { startServer } from '../../src/human-goal-workbench/server.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();vi.restoreAllMocks();});

async function fixture(){const root=mkdtempSync(join(tmpdir(),'agent-case-')),source=join(root,'source'),evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);writeFileSync(join(source,'main.ts'),'export const main = 1;\n');writeFileSync(join(evidence,'selected.jsonl'),'');
 const config={projects:[{id:'self',label:'Fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 const service=new HumanGoalService(config,{revision:'fixture',async analyze(){throw new Error('No provider needed');}} as any,{dispatchRoundAnalysis:false});cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Observe who works and what is verified',author:'test',provenance:'fixture',clauses:[{id:'goal',text:'Observe who works',importance:'core'}],analyze:false});
 vi.spyOn(Server.prototype,'listen').mockImplementation(function(this:Server,...args:any[]){queueMicrotask(()=>args.at(-1)());return this;});vi.spyOn(Server.prototype,'close').mockImplementation(function(this:Server,cb?:any){cb?.();return this;});
 const app=await startServer(service,9999);cleanup.push(async()=>app.close());
 const request=(path:string,body?:unknown,origin='http://127.0.0.1:9999')=>new Promise<{status:number;data:any}>(resolve=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]) as any;req.url=path;req.method=body?'POST':'GET';req.headers={host:'127.0.0.1:9999',origin,'content-type':'application/json'};app.server.emit('request',req,{statusCode:200,setHeader(){},end(value:string){resolve({status:this.statusCode,data:JSON.parse(value)});}});});
 return {service,config,source,evidence,request};}
it('same-origin connection follows only selected evidence, keeps reports and proof separate, and refuses control routes',async()=>{const {service,source,evidence,request}=await fixture(),goal=service.read('self').goals[0];
 const body={id:'connection',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format:'codex-native-rollout',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:goal.hash,purpose:'Observe development',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path:'selected.jsonl'},start:'from-now'};
 expect((await request('/api/projects/self/activity-connect',body)).status).toBe(200);
 expect((await request('/api/projects/self/activity-connect',{...body,id:'other'},'http://evil.test')).status).toBe(403);
 expect((await request('/api/projects/self/agent-command',{argv:['sh']})).status).toBe(404);
 appendFileSync(join(evidence,'selected.jsonl'),[
  {type:'session_meta',timestamp:'2026-09-23T00:00:00Z',payload:{id:'session-a',cwd:source,cli_version:'0.155.0-alpha.9.2'}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:00Z',payload:{type:'task_started',turn_id:'turn-1',root_turn_id:'turn-1'}},
  {type:'turn_context',timestamp:'2026-09-23T00:00:00Z',payload:{turn_id:'turn-1',root_turn_id:'turn-1',cwd:source}},
  {type:'response_item',timestamp:'2026-09-23T00:00:01Z',payload:{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'call',arguments:JSON.stringify({task_name:'research',message:'SECRET command output'})}},
  {type:'event_msg',timestamp:'2026-09-23T00:00:02Z',payload:{type:'task_complete',turn_id:'turn-1'}}
 ].map(x=>JSON.stringify(x)+'\n').join(''));service.activity.poll('self','connection');
 const projected=(await request('/api/projects/self/activity')).data;expect(projected.turns[0].status).toBe('child-unknown');expect(projected.turns[0].verified).toBe(false);expect(JSON.stringify(projected)).not.toContain('SECRET');
 const state=(await request('/api/projects/self/state')).data;expect(state.activity.turns[0].roundId).toBeTruthy();expect(state.rounds.rounds[0].status).toBe('agent-unknown');
});
it('keyboard tab and DOM cards show linked round, unknown child activity, and escaped external text',async()=>{const {service,config,source,evidence,request}=await fixture(),goal=service.read('self').goals[0];
 service.activity.connect('self',{id:'connection',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format:'codex-native-rollout',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:goal.hash,purpose:'Observe agents <img onerror=attack()>',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path:'selected.jsonl'},start:'from-now'});
 appendFileSync(join(evidence,'selected.jsonl'),[{type:'session_meta',timestamp:'2026-09-23T00:00:00Z',payload:{id:'session-a',cwd:source,cli_version:'0.155.0-alpha.9.2'}},{type:'event_msg',timestamp:'2026-09-23T00:00:00Z',payload:{type:'task_started',turn_id:'turn-1',root_turn_id:'turn-1'}},{type:'turn_context',timestamp:'2026-09-23T00:00:00Z',payload:{turn_id:'turn-1',root_turn_id:'turn-1',cwd:source}},{type:'response_item',timestamp:'2026-09-23T00:00:01Z',payload:{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'call',arguments:JSON.stringify({task_name:'research',message:'SECRET'})}},{type:'event_msg',timestamp:'2026-09-23T00:00:02Z',payload:{type:'task_complete',turn_id:'turn-1'}}].map(x=>JSON.stringify(x)+'\n').join(''));service.activity.poll('self','connection');
 const dom=new JSDOM(readFileSync('src/human-goal-workbench/index.html','utf8'),{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true});cleanup.push(async()=>dom.window.close());const w=dom.window as any;w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(url:string,options?:any)=>{const result=await request(url,options?.body?JSON.parse(options.body):undefined);return {ok:result.status<400,json:async()=>result.data};};w.eval(readFileSync('src/human-goal-workbench/client.js','utf8'));await new Promise(r=>setTimeout(r,50));
 const tab=w.document.querySelector('#tab-agents');tab.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));tab.click();expect(tab.getAttribute('aria-selected')).toBe('true');
 expect(w.document.querySelector('#agent-turns').textContent).toContain('子代理状态未知');expect(w.document.querySelector('#agent-turns').textContent).toContain('查看开发轮次');
 expect(w.document.querySelector('#agent-turns').textContent).toContain('子代理内部工具轨迹未观察到');expect(w.document.querySelector('#agent-turns img')).toBeNull();
 expect(w.document.querySelector('#agent-connections').open).toBe(false);expect(w.document.querySelector('#agent-turns').compareDocumentPosition(w.document.querySelector('#agent-connections'))&w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
