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
import { projectMainlineProgress } from '../../src/core/human-goal-workflow/mainline-progress.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();vi.restoreAllMocks();});
const line=(value:unknown)=>JSON.stringify(value)+'\n';
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mainline-case-')),source=join(root,'source'),evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);
 writeFileSync(join(source,'main.ts'),'export const answer = 1;\n');writeFileSync(join(evidence,'stream.jsonl'),'');writeFileSync(join(evidence,'next.jsonl'),'');
 const config={projects:[{id:'self',label:'Fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 let service=new HumanGoalService(config,{revision:'unused',async analyze(){throw Error('provider must not run');}} as any,{dispatchRoundAnalysis:false});
 cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Show a useful answer',author:'owner',provenance:'fixture',clauses:[{id:'goal',text:'Show the answer',importance:'core'}],analyze:false});
 const goal=service.read('self').goals[0];
 service.activity.connect('self',{id:'connection',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',format:'codex-exec-jsonl',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:goal.hash,purpose:'Make the answer visible',clauseIds:['goal'],journeyIds:[],selectedActionIds:[],stream:{rootIndex:0,path:'stream.jsonl'},start:'from-now'});
 appendFileSync(join(source,'main.ts'),'export const visible = true;\n');
 appendFileSync(join(evidence,'stream.jsonl'),[{type:'thread.started',thread_id:'thread'},{type:'turn.started',turn_id:'turn'},{type:'item.completed',item:{id:'edit',type:'file_change',status:'completed',changes:[{path:'main.ts'}]}},{type:'turn.completed',turn_id:'turn'}].map(line).join(''));
 service.activity.poll('self','connection');
 const s=service.read('self'),snapshot=discoverSource(service.project('self')),file=snapshot.files.find(f=>f.path==='main.ts')!,ref={path:'main.ts',sha256:file.sha256,start:1,end:1};
 s.views=[{generation:s.generation,attemptId:'view',source:snapshot,goal,analysis:{purpose:'Show answer',purposeRefs:[ref],limitations:[],modules:[{id:'answer',title:'Answer',kind:'discovered',responsibility:'produce answer',inputs:[],outputs:[],refs:[ref],supersedes:[]}],edges:[],workflow:{status:'established',summary:'One observed step',coverage:'registered-scope',unknowns:[],journeys:[{id:'journey',title:'See the answer',purpose:'See the answer',clauseIds:['goal'],observed:{steps:[{id:'step',title:'Render the answer',purpose:'Display answer',actor:'user',responsibility:'read',inputs:['request'],outputs:['answer'],actual:'Source present',state:'source-supported',targetIds:['answer'],clauseIds:['goal'],refs:[ref],uncertainty:'Runtime unknown'}],links:[]},desired:{steps:[],links:[]}}]},alignments:[],gaps:[],conflicts:[],changes:[],coverageNotes:'fixture',feedbackResponse:'fixture'},gaps:[],createdAt:new Date().toISOString(),status:'completed',changes:{goal:'',interpretation:'',source:'',ranking:'',evidence:''}} as any];s.currentView=0;service.store.save(s);
 const roundId=service.read('self').rounds!.registrations[0].binding.roundId;
 service.annotateMainline('self',{expectedRevision:0,idempotencyKey:'map-1',roundId,goalHash:goal.hash,viewAttemptId:'view',sourceHash:snapshot.hash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Make the answer visible',expectedVerification:'User sees the answer',previousId:null,author:'owner'});
 vi.spyOn(Server.prototype,'listen').mockImplementation(function(this:Server,...args:any[]){queueMicrotask(()=>args.at(-1)());return this;});
 vi.spyOn(Server.prototype,'close').mockImplementation(function(this:Server,cb?:any){cb?.();return this;});
 const app=await startServer(service,9999);cleanup.push(async()=>app.close());
 const request=(path:string,payload?:unknown)=>new Promise<{status:number;data:any}>(resolve=>{const req=Readable.from(payload?[Buffer.from(JSON.stringify(payload))]:[]) as any;req.url=path;req.method=payload?'POST':'GET';req.headers={host:'127.0.0.1:9999',origin:'http://127.0.0.1:9999','content-type':'application/json'};app.server.emit('request',req,{statusCode:200,setHeader(){},end(value:string){resolve({status:this.statusCode,data:JSON.parse(value)});}});});
 return {service,source,evidence,roundId,request,reopen:async()=>{await service.close();service=new HumanGoalService(config,{revision:'unused',async analyze(){throw Error('provider must not run');}} as any,{dispatchRoundAnalysis:false});return service;}};
}
async function browser(request:(path:string,payload?:unknown)=>Promise<{status:number;data:any}>){
 const dom=new JSDOM(readFileSync('src/human-goal-workbench/index.html','utf8'),{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true});cleanup.push(async()=>dom.window.close());
 const w=dom.window as any;w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(url:string,options?:any)=>{const result=await request(url,options?.body?JSON.parse(options.body):undefined);return {ok:result.status<400,json:async()=>result.data};};
 w.eval(readFileSync('src/human-goal-workbench/client.js','utf8'));await new Promise(r=>setTimeout(r,70));return w;
}
const clickText=(w:any,selector:string,text:string)=>{const item=[...w.document.querySelectorAll(selector)].find((n:any)=>n.textContent.includes(text));expect(item).toBeTruthy();item.click();return item;};

it('shares the projection across API panels and supports round to step to activity navigation with an append-only correction',async()=>{
 const {service,roundId,request}=await fixture(),state=(await request('/api/projects/self/state')).data,activity=(await request('/api/projects/self/activity')).data;
 expect(state.mainline.rounds[0].status).toBe('changed-unverified');expect(activity.mainline.rounds).toEqual(state.mainline.rounds);
 expect(activity.turns[0].mainline).toEqual(state.mainline.rounds[0]);
 const w=await browser(request);expect(w.document.querySelector('[data-step-id="step"]').getAttribute('data-mainline-status')).toBe('changed-unverified');
 expect(w.document.querySelector('.mainline-feed').textContent).toContain('来源变化');
 w.document.querySelector('#tab-agents').click();clickText(w,'#agent-turns button','查看产品主线');
 expect(w.document.querySelector('#tab-map').getAttribute('aria-selected')).toBe('true');expect(w.document.querySelector('#workflow-journey').value).toBe('journey');
 expect(w.document.querySelector('#detail').textContent).toContain('相关开发轮次');
 clickText(w,'.mainline-feed button','返回实时开发');expect(w.document.querySelector('#tab-agents').getAttribute('aria-selected')).toBe('true');
 clickText(w,'#agent-turns button','修订关联');const form=w.document.querySelector('#dialog-body form');
 const areas=form.querySelectorAll('textarea');areas[0].value='Support the answer step by removing a blocker';areas[1].value='A user can read the answer';
 form.querySelectorAll('select')[1].value='support-infrastructure';form.querySelector('input:not([type=checkbox])').value='reviewer';
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,70));
 const annotations=service.read('self').mainlineAnnotations!.annotations;expect(annotations).toHaveLength(2);expect(annotations[1]).toMatchObject({roundId,previousId:annotations[0].id,kind:'support-infrastructure'});
 expect(service.read('self').goals).toHaveLength(1);expect(service.read('self').rounds!.registrations).toHaveLength(1);
});

it('requires explicit journey, step, purpose and verification when connecting from the current mainline',async()=>{
 const {service,request}=await fixture(),w=await browser(request);w.document.querySelector('#tab-agents').click();w.document.querySelector('#connect-agent').click();
 const form=w.document.querySelector('#dialog-body form');expect(form.textContent).toContain('要推进的产品旅程');expect(form.textContent).toContain('实际关联的步骤');
 const fields=form.querySelectorAll('input');for(const input of fields){if(input.placeholder==='feature/my-work')input.value='fixture';if(input.placeholder==='rollout/selected-session.jsonl')input.value='next.jsonl';if(input.type==='checkbox')input.checked=true;}
 const textareas=form.querySelectorAll('textarea');textareas[0].value='Develop next turn';textareas[1].value='Directly improve the answer';textareas[2].value='Check the user-visible answer';
 form.querySelector('input[pattern]').value='next-task';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,70));
 const connection=service.read('self').agentActivity!.connections.at(-1)!;expect(connection.mainlineIntent).toMatchObject({journeyId:'journey',stepIds:['step'],kind:'direct-product'});expect(connection.journeyIds).toEqual(['journey']);
});

it('retains saved intent through a source edit, explicit historical association, navigation and restart without proof',async()=>{
 const f=await fixture();appendFileSync(join(f.source,'main.ts'),'// next source revision\n');
 const state=(await f.request('/api/projects/self/state')).data;
 expect(state.mainline.status).toBe('stale-source');expect(state.mainline.rounds[0].steps).toEqual([]);
 expect(state.mainline.rounds[0].intentSteps[0].title).toBe('Render the answer');
 expect(state.mainline.rounds[0].mapping.state).toBe('stale');expect(state.activity.turns[0].verified).toBe(false);
 const w=await browser(f.request);expect(w.document.querySelector('[data-step-id="step"]').getAttribute('data-mainline-status')).toBe('stale');
 expect(w.document.querySelector('#workflow-content').textContent).toContain('当前源码');
 expect(w.document.querySelector('.mainline-feed').textContent).toContain('Make the answer visible');
 w.document.querySelector('#tab-agents').click();
 expect(w.document.querySelector('#agent-turns').textContent).toContain('Render the answer');
 expect(w.document.querySelector('#agent-turns').textContent).toContain('User sees the answer');
 expect(w.document.querySelector('#agent-turns').textContent).not.toContain('限定条件已验证');
 clickText(w,'#agent-turns button','查看保存的产品主线');
 expect(w.document.querySelector('#workflow-journey').value).toBe('journey');
 clickText(w,'.mainline-feed button','返回实时开发');
 expect(w.document.querySelector('#tab-agents').getAttribute('aria-selected')).toBe('true');
 expect(w.document.activeElement.dataset.roundId).toBe(f.roundId);
 w.document.querySelector('#tab-rounds').click();clickText(w,'#round-detail button','查看保存的产品主线');
 clickText(w,'.mainline-feed button','返回开发轮次');
 expect(w.document.querySelector('#tab-rounds').getAttribute('aria-selected')).toBe('true');
 expect(w.document.querySelector('#round-detail').dataset.roundId).toBe(f.roundId);
 w.document.querySelector('#tab-agents').click();
 clickText(w,'#agent-turns button','按当前保存主线修订关联');
 const form=w.document.querySelector('#dialog-body form');expect(form.textContent).toContain('只把已观察轮次解释为保存分析中的开发意图');
 const checkboxes=form.querySelectorAll('input[type=checkbox]');expect(checkboxes).toHaveLength(2);checkboxes[0].checked=true;
 form.querySelector('input:not([type=checkbox])').value='reviewer';
 checkboxes[0].checked=false;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 expect(f.service.read('self').mainlineAnnotations!.annotations).toHaveLength(1);
 checkboxes[0].checked=true;
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,80));
 const annotations=f.service.read('self').mainlineAnnotations!.annotations;
 expect(annotations).toHaveLength(2);expect(annotations[1]).toMatchObject({previousId:annotations[0].id,interpretationMode:'historical-intent',observedSourceHash:annotations[0].sourceHash});
 const reopened=await f.reopen(),current=discoverSource(reopened.project('self'));
 const saved=projectMainlineProgress(reopened.read('self'),current.hash);
 expect(saved.rounds[0].mapping.state).toBe('stale');expect(saved.rounds[0].intentSteps[0].title).toBe('Render the answer');expect(saved.rounds[0].steps).toEqual([]);
});

it('shows an old analysis association as pending remap when a new view reuses its IDs',async()=>{
 const f=await fixture(),s=f.service.read('self');s.views.push({...s.views[0],attemptId:'view-new'});s.currentView=1;f.service.store.save(s);
 const state=(await f.request('/api/projects/self/state')).data;
 expect(state.mainline.status).toBe('current');expect(state.mainline.rounds[0].mapping.intentRelation).toBe('pending-remap');
 expect(state.mainline.journeys[0].steps[0].work).toEqual([]);
 const w=await browser(f.request);w.document.querySelector('#tab-agents').click();
 expect(w.document.querySelector('#agent-turns').textContent).toContain('当前分析已换版');
 clickText(w,'#agent-turns button','按当前保存主线修订关联');
 const form=w.document.querySelector('#dialog-body form');expect(form.textContent).toContain('不会自动沿用');
 const choices=form.querySelectorAll('select');expect(choices[0].value).toBe('');
 choices[0].value='journey';choices[0].dispatchEvent(new w.Event('change',{bubbles:true}));
 expect(form.querySelector('input[type=checkbox]').checked).toBe(false);
 form.querySelector('input[type=checkbox]').checked=true;
 form.querySelector('input:not([type=checkbox])').value='reviewer';
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,80));
 const annotations=f.service.read('self').mainlineAnnotations!.annotations;
 expect(annotations).toHaveLength(2);expect(annotations[1]).toMatchObject({viewAttemptId:'view-new',previousId:annotations[0].id});
});
