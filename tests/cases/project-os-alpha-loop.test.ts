import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Server } from 'node:http';
import { Readable } from 'node:stream';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { startServer } from '../../src/human-goal-workbench/server.js';
import { discoverSource } from '../../src/core/human-goal-workflow/source.js';
import { hash } from '../../src/core/human-goal-workflow/types.js';
import { probeMainline } from '../../scripts/project-os-verify.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();vi.restoreAllMocks();});

async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'alpha-case-')),source=join(root,'source'),evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);
 writeFileSync(join(source,'main.ts'),'export const answer = false;\n');writeFileSync(join(evidence,'stream.jsonl'),'');
 const config={projects:[{id:'self',label:'Fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 const service=new HumanGoalService(config,{revision:'fixture',async analyze(){throw Error('provider not used');}} as any,{dispatchRoundAnalysis:false});cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Show the correct answer',author:'owner',provenance:'fixture',clauses:[{id:'goal',text:'Show the answer',importance:'core'}],analyze:false});
 const goal=service.read('self').goals[0];
 service.activity.connect('self',{id:'connection',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format:'codex-exec-jsonl',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:goal.hash,purpose:'Fix reader result',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path:'stream.jsonl'},start:'from-now'});
 appendFileSync(join(source,'main.ts'),'export const fixed = true;\n');
 appendFileSync(join(evidence,'stream.jsonl'),[{type:'thread.started',thread_id:'thread'},{type:'turn.started',turn_id:'turn'},{type:'item.completed',item:{id:'edit',type:'file_change',status:'completed',changes:[{path:'main.ts'}]}},{type:'turn.completed',turn_id:'turn'}].map(x=>JSON.stringify(x)+'\n').join(''));
 service.activity.poll('self','connection');
 const s=service.read('self'),snapshot=discoverSource(service.project('self')),file=snapshot.files.find(f=>f.path==='main.ts')!,ref={path:'main.ts',sha256:file.sha256,start:1,end:1};
 const criterion={id:'criterion',text:'Reader sees correct answer',observable:'Read rendered result',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'none'};
 const scenario={id:'scenario',title:'Read answer',critical:'critical',given:'Page open',when:'Read',then:'Correct',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'none',criteria:[criterion]};
 s.views=[{generation:s.generation,attemptId:'view',source:snapshot,goal,analysis:{purpose:'Show answer',purposeRefs:[ref],limitations:[],modules:[{id:'answer',title:'Answer',kind:'discovered',responsibility:'Show answer',inputs:[],outputs:[],refs:[ref],supersedes:[]}],edges:[],workflow:{status:'established',summary:'Read',coverage:'registered-scope',unknowns:[],journeys:[{id:'journey',title:'Read answer',purpose:'See answer',clauseIds:['goal'],observed:{steps:[{id:'step',title:'Render answer',purpose:'Show answer',actor:'user',responsibility:'read',inputs:['request'],outputs:['answer'],actual:'Source present',state:'source-supported',targetIds:['answer'],clauseIds:['goal'],refs:[ref],uncertainty:'Runtime unknown'}],links:[]},desired:{steps:[],links:[]}}]},alignments:[],gaps:[],conflicts:[],changes:[],coverageNotes:'fixture',feedbackResponse:'fixture'},gaps:[],createdAt:new Date().toISOString(),status:'completed',changes:{goal:'',interpretation:'',source:'',ranking:'',evidence:''}} as any];s.currentView=0;
 const base={id:'confirmation',goalHash:goal.hash,goalVersion:goal.version,sourceHash:snapshot.hash,analysisAttemptId:'view',scenarios:[scenario],status:'confirmed',author:'owner',createdAt:new Date().toISOString(),roundId:null};s.scenarioSets=[{...base,hash:hash(base)} as any];service.store.save(s);
 const roundId=service.read('self').rounds!.registrations[0].binding.roundId;
 service.annotateMainline('self',{expectedRevision:0,idempotencyKey:'map',roundId,goalHash:goal.hash,viewAttemptId:'view',sourceHash:snapshot.hash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Correct the visible result',expectedVerification:'Reader sees correct answer',previousId:null,author:'owner'});
 const binding=service.verificationContext('self',roundId).binding,checked=binding.criteria[0],now=new Date().toISOString(),receipt={id:'after-pass',binding,sourceAfterHash:binding.sourceHash,sourceChanged:false,startedAt:now,endedAt:now,checks:[{id:'check',configHash:hash('check'),startedAt:now,endedAt:now,exitCode:0,executionError:null,stdout:'PROJECT_OS_ASSERTION {"assertionId":"answer","status":"passed"}',stderr:'',assertions:[{...checked,assertionId:'answer',status:'passed',actual:'Visible',evidence:'Fixture check'}],traces:[]}]};
 const saved=service.read('self');saved.verificationReceipts=[receipt as any];service.store.save(saved);
 vi.spyOn(Server.prototype,'listen').mockImplementation(function(this:Server,...args:any[]){queueMicrotask(()=>args.at(-1)());return this;});
 vi.spyOn(Server.prototype,'close').mockImplementation(function(this:Server,cb?:any){cb?.();return this;});
 const app=await startServer(service,9999);cleanup.push(async()=>app.close());
 const request=(path:string)=>new Promise<{status:number;data:any}>(resolve=>{const req=Readable.from([]) as any;req.url=path;req.method='GET';req.headers={host:'127.0.0.1:9999'};app.server.emit('request',req,{statusCode:200,setHeader(){},end(value:string){resolve({status:this.statusCode,data:JSON.parse(value)});}});});
 return {service,roundId,request};
}
async function browser(request:(path:string)=>Promise<{status:number;data:any}>){const dom=new JSDOM(readFileSync('src/human-goal-workbench/index.html','utf8'),{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true});cleanup.push(async()=>dom.window.close());const w=dom.window as any;w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.fetch=async(url:string)=>{const result=await request(url);return {ok:result.status<400,json:async()=>result.data};};w.eval(readFileSync('src/human-goal-workbench/client.js','utf8'));await new Promise(r=>setTimeout(r,70));return w;}

it('shares one before/after projection across state, activity, mainline, selected round and live turn',async()=>{
 const f=await fixture(),state=(await f.request('/api/projects/self/state')).data,activity=(await f.request('/api/projects/self/activity')).data;
 const progress=state.mainline.rounds.find((r:any)=>r.roundId===f.roundId);
 expect(progress.comparison).toMatchObject({state:'unknown-before',criteria:[{before:{status:'unknown'},after:{status:'passed',receiptIds:['after-pass']}}]});
 expect(activity.mainline.rounds).toEqual(state.mainline.rounds);expect(activity.turns[0].mainline.comparison).toEqual(progress.comparison);
 const w=await browser(f.request);
 expect(w.document.querySelector('.mainline-feed .alpha-comparison').textContent).toContain(progress.comparison.summary);
 w.document.querySelector('#tab-rounds').click();expect(w.document.querySelector('#round-detail').dataset.roundId).toBe(f.roundId);
 expect(w.document.querySelector('#round-detail .alpha-comparison').textContent).toContain('此前 未知 / 缺证 → 本轮 限定通过');
 w.document.querySelector('#tab-agents').click();expect(w.document.querySelector('#agent-turns .alpha-comparison').textContent).toContain(progress.comparison.summary);
 const detail=w.document.querySelector('#agent-turns .alpha-comparison details');detail.open=true;[...detail.querySelectorAll('button')].find((b:any)=>b.textContent.includes('after-pass')).click();
 expect(w.document.querySelector('#dialog-body').textContent).toContain('目标 G1');
});

it('loopback probe computes separate source, binding and projection assertions for the selected round',async()=>{
 const f=await fixture(),results:{id:string;status:string}[]=[],fetcher=async(url:string)=>{const result=await f.request(new URL(url).pathname+new URL(url).search);return new Response(JSON.stringify(result.data),{status:result.status});};
 await probeMainline('http://127.0.0.1:9999/','self',f.roundId,fetcher as any,(id,status)=>results.push({id,status}));
 expect(results).toHaveLength(7);expect(results.map(x=>x.status)).toEqual(Array(7).fill('passed'));
 const broken=async(url:string)=>{const result=await f.request(new URL(url).pathname+new URL(url).search);if(new URL(url).pathname.endsWith('/source'))result.data.sha256='wrong';return new Response(JSON.stringify(result.data),{status:result.status});};
 const negative:{id:string;status:string}[]=[];await probeMainline('http://127.0.0.1:9999/','self',f.roundId,broken as any,(id,status)=>negative.push({id,status}));
 expect(negative.find(x=>x.id==='alpha-source-reference')?.status).toBe('behavior-failed');
 expect(negative.find(x=>x.id==='alpha-receipt-bindings')?.status).toBe('passed');
});

it('keeps the explicitly selected round and its own comparison after a newer round appears',async()=>{
 const f=await fixture(),service=f.service,source=service.project('self').sourceRoot,goal=service.read('self').goals[0],before=service.rounds.capture('self');
 writeFileSync(join(service.project('self').evidenceRoots![0],'next.jsonl'),'');
 service.rounds.enroll('self',{id:'registration-next',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',tool:'codex-exec',toolVersion:'0.155.0-alpha.9.2',taskId:'next',roundId:'round-next',attemptId:'attempt-next',producerId:'producer-next',mode:'live',goalHash:goal.hash,feedbackIds:[],purpose:'Investigate next issue',clauseIds:['goal'],journeyIds:['journey'],selectedActionIds:[],acceptedPlan:null,beforeSnapshotId:before.id,stream:{rootIndex:0,path:'next.jsonl'},deferredBenefit:null});
 const after=service.rounds.checkpoint('self','registration-next');for(const [sequence,kind,description] of [[1,'begin','turn-start'],[2,'completed','turn-completed']] as const)service.rounds.accept('self',{key:`next-${sequence}`,projectId:'self',registrationId:'registration-next',roundId:'round-next',attemptId:'attempt-next',producerId:'producer-next',sequence,dependsOn:[],kind,description,rawHash:hash(sequence),observedAt:new Date().toISOString(),sourceSnapshotId:sequence===2?after.id:null});
 const w=await browser(f.request);w.document.querySelector('#tab-rounds').click();
 expect(w.document.querySelector('#round-detail').dataset.roundId).toBe('round-next');
 [...w.document.querySelectorAll('.round-link')].find((b:any)=>b.textContent.includes('Fix reader result')).click();
 expect(w.document.querySelector('#round-detail').dataset.roundId).toBe(f.roundId);
 expect(w.document.querySelector('#round-detail .alpha-comparison').textContent).toContain('Reader sees correct answer');
 expect(w.document.querySelector('#round-detail').textContent).not.toContain('Investigate next issue');
});
