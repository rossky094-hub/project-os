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
import { digest, hash } from '../../src/core/human-goal-workflow/types.js';
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

it('updates the current action across every reader surface after new judgment, and retains the authored action as history',async()=>{
 const f=await fixture(),s=f.service.read('self'),prior=s.mainlineAnnotations!.annotations.at(-1)!,ref=s.views[0].analysis.purposeRefs[0];
 const diagnosis=(action:string)=>({scope:'workflow',certainty:'supported-hypothesis',scopeReason:'Check the whole result before local work',conclusion:'The visible answer still needs a matching result',clauseIds:['goal'],journeys:[],evidence:[ref],counterEvidence:[],alternatives:[],recommendation:{action,reason:'The previous check was completed; this is the remaining common blocker',clauseIds:['goal'],targetIds:['answer'],journeyIds:['journey'],options:[],verificationJourney:'Observe the requested answer on the real reader path'},taskAssessment:{reason:'Advance the requested result',remaining:'Check the real answer'}});
 s.views[0].analysis.diagnosis=diagnosis('OLD_ANALYSIS_ACTION') as any;
 const scenario={id:'scenario-answer',title:'Read answer',critical:'critical',given:'Current goal',when:'Read',then:'See matching answer',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'Runtime not yet checked',criteria:[{id:'answer-result',text:'Answer matches goal',observable:'Read actual answer',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'Not yet checked'}]};
 const confirmation={id:'confirmed-answer',goalHash:prior.goalHash,goalVersion:1,sourceHash:prior.sourceHash,analysisAttemptId:'view',scenarios:[scenario],status:'confirmed',author:'fixture reviewer',createdAt:new Date().toISOString(),roundId:f.roundId};
 s.scenarioSets=[{...confirmation,hash:hash(confirmation)} as any];f.service.store.save(s);
 const delivery={title:'This round made the answer visible',goalConnection:'Read a useful answer',before:'Hidden answer',after:'Visible answer',evidenceSummary:'The visibility check ran',receiptIds:[],remaining:'Answer meaning still needs checking',nextAction:'OLD_AUTHORED_CHECK_ALREADY_FINISHED',nextCheck:'OLD_AUTHORED_OBSERVATION'};
 f.service.annotateMainline('self',{expectedRevision:s.mainlineAnnotations!.revision,idempotencyKey:'old-action-report',roundId:f.roundId,goalHash:prior.goalHash,viewAttemptId:'view',sourceHash:prior.sourceHash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Show the actual round change',expectedVerification:delivery.nextCheck,previousId:prior.id,author:'developer',delivery});
 const updated=f.service.read('self'),next=structuredClone(updated.views[0]);next.attemptId='new-judgment';next.analysis.diagnosis=diagnosis('CURRENT_BUSINESS_ACTION') as any;
 updated.views.push(next);updated.currentView=1;updated.analysisContinuations=[{fromAttemptId:'view',toAttemptId:next.attemptId,sourceHash:prior.sourceHash,goalHash:prior.goalHash,fromAnalysisHash:hash(updated.views[0].analysis),toAnalysisHash:hash(next.analysis),createdAt:new Date().toISOString()}];f.service.store.save(updated);
 const projected=(await f.request('/api/projects/self/state')).data;
 expect(projected.mainline.rounds[0].delivery.current).toBe(true);expect(projected.closedLoop.nextAction).toBe('CURRENT_BUSINESS_ACTION');
 const w=await browser(f.request),d=w.document;
 expect(d.querySelector('#overall-diagnosis .delivery-preview').textContent).toContain('CURRENT_BUSINESS_ACTION');
 expect(d.querySelector('#overall-diagnosis .delivery-preview').textContent).not.toContain(delivery.nextAction);
 expect(d.querySelector('#overall-diagnosis .recorded-action').textContent).toContain(delivery.nextAction);
 expect(d.querySelector('.mainline-next').textContent).toContain('CURRENT_BUSINESS_ACTION');
 for(const [tab,host]of [['rounds','#round-detail'],['agents','#agent-turns']]){d.querySelector('#tab-'+tab).click();expect(d.querySelector(host+' .current-action').textContent).toContain('CURRENT_BUSINESS_ACTION');}
 d.querySelector('#tab-map').click();d.querySelector('#review-round').click();clickText(w,'#dialog-body button','5 下一行动');
 expect(d.querySelector('.reader-context .current-action').textContent).toContain('CURRENT_BUSINESS_ACTION');expect(d.querySelector('#reader-answer').value).toBe('');d.querySelector('#close-dialog').click();
 const rawBefore=hash(f.service.read('self').mainlineAnnotations);const reopened=await f.reopen();
 expect(hash(reopened.read('self').mainlineAnnotations)).toBe(rawBefore);expect(reopened.read('self').mainlineAnnotations!.annotations.at(-1)?.delivery?.nextAction).toBe(delivery.nextAction);
});

it('immediately withdraws old actions when a reader correction is saved without reanalysis, rather than recommending old completed work',async()=>{
 const f=await fixture(),s=f.service.read('self'),prior=s.mainlineAnnotations!.annotations.at(-1)!;
 const delivery={title:'Round explanation',goalConnection:'Read answer',before:'Hidden',after:'Visible',evidenceSummary:'Developer report',receiptIds:[],remaining:'Meaning unknown',nextAction:'OBSOLETE_DEVELOPER_ACTION',nextCheck:'OBSOLETE_CHECK'};
 f.service.annotateMainline('self',{expectedRevision:s.mainlineAnnotations!.revision,idempotencyKey:'pending-action-report',roundId:f.roundId,goalHash:prior.goalHash,viewAttemptId:'view',sourceHash:prior.sourceHash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Visible result',expectedVerification:delivery.nextCheck,previousId:prior.id,author:'developer',delivery});
 const w=await browser(f.request),d=w.document;d.querySelector('#correct-delivery').click();d.querySelector('#delivery-correction').value='The actual answer still contradicts the goal';
 await d.querySelector('#dialog-body form').onsubmit(new w.Event('submit',{cancelable:true}));
 expect(d.querySelector('#overall-diagnosis .current-action').textContent).toContain('重新分析');
 expect(d.querySelector('#overall-diagnosis .delivery-preview').textContent).not.toContain(delivery.nextAction);
 expect(d.querySelector('.mainline-next').textContent).toContain('重新分析');
 d.querySelector('#review-round').click();clickText(w,'#dialog-body button','5 下一行动');expect(d.querySelector('.reader-context .current-action').textContent).toContain('重新分析');
 expect(f.service.read('self').feedback.at(-1)?.originalText).toBe('The actual answer still contradicts the goal');expect(f.service.read('self').attempts).toHaveLength(0);
});

it.each(['goal','module','source'])('keeps the current action aligned when the %s changes, without lending the old round result to the new intention',async change=>{
 const f=await fixture(),before=(await f.request('/api/projects/self/state')).data,w=await browser(f.request);
 if(change==='source')appendFileSync(join(f.source,'main.ts'),'export const nextAnswer = 2;\n');
 else{
  const q={expectedGeneration:before.generation,idempotencyKey:'change-'+change,kind:'desired-change',originalText:change==='goal'?'Show the reason for the answer':'The answer module should explain its reason',targetIds:change==='module'?['answer']:[],author:'fixture reviewer',provenance:'Explicit test input, not user acceptance',analyze:false,...(change==='module'?{expectation:{targetId:'answer',responsibility:'Explain the answer reason',inputs:['request'],outputs:['answer','reason'],examples:['Read the reason'],clauseIds:['goal'],disposition:'required',replaces:[]}}:{})};
  expect((await f.request('/api/projects/self/feedback',q)).status).toBe(200);
 }
 await w.eval('refresh(true)');const d=w.document,current=(await f.request('/api/projects/self/state')).data;
 expect(current.closedLoop.nextActionDetails.kind).toBe('analysis-required');
 expect(d.querySelector('#overall-diagnosis .current-action').textContent).toContain('重新分析');
 expect(d.querySelector('#overall-diagnosis .current-action button').textContent).toContain('重新检查');
 if(change==='goal'){expect(current.goals.at(-1).originalText).toBe('Show the reason for the answer');expect(current.goals.at(-1).hash).not.toBe(before.goals.at(-1).hash);expect(current.mainline.rounds[0].mapping.state).toBe('stale');}
 else{expect(current.goals.at(-1).hash).toBe(before.goals.at(-1).hash);if(change==='module')expect(current.expectations[0].outputs).toEqual(['answer','reason']);else expect(current.mainline.rounds[0].steps).toEqual([]);}
 expect(current.closedLoop.status).not.toBe('verified');expect(f.service.read('self').mainlineAnnotations!.annotations).toHaveLength(1);
});

it('loads a single hash-bound observation original on demand while keeping polling responses small',async()=>{
 const f=await fixture(),s=f.service.read('self'),before=s.mainlineAnnotations!.annotations.at(-1)!;
 const rawRecord=JSON.stringify({schema:'project-os.scoped-observation.v1',producer:'fixture',sourceHash:before.sourceHash,goalHash:before.goalHash,targetIds:['answer'],clauseIds:['goal'],roundIds:[f.roundId],result:'passed',behaviorScope:true,scopeSummary:'One fixture output',limitations:['Not human acceptance'],invocation:{kind:'shell',argv:['fixture'],stdout:'ORIGINAL_OUTPUT_SENTINEL',stderr:'',exitCode:0}});
 writeFileSync(join(f.evidence,'original.json'),rawRecord);
 const observed=f.service.observe('self',{expectedGeneration:s.generation,idempotencyKey:'original',producer:'fixture',rawRecord,rawHash:digest(rawRecord),sourceHash:before.sourceHash,goalHash:before.goalHash,targetIds:['answer'],clauseIds:['goal'],result:'passed',trustedRecord:{rootIndex:0,path:'original.json'}}) as any;
 const refreshed=f.service.read('self');
 const delivery={title:'Read the actual result',goalConnection:'See the answer',before:'Hidden answer',after:'Visible answer',evidenceSummary:'Fixture scoped check',receiptIds:[],observationIds:[observed.observationId],remaining:'Human understanding unknown',nextAction:'Inspect one answer',nextCheck:'Matches the request'};
 f.service.annotateMainline('self',{expectedRevision:refreshed.mainlineAnnotations!.revision,idempotencyKey:'original-delivery',roundId:f.roundId,goalHash:before.goalHash,viewAttemptId:before.viewAttemptId,sourceHash:before.sourceHash,journeyId:before.journeyId,stepIds:before.stepIds,kind:'direct-product',reason:'Read the actual evidence',expectedVerification:delivery.nextCheck,previousId:before.id,author:'developer',delivery});
 const state=(await f.request('/api/projects/self/state')).data,history=(await f.request('/api/projects/self/history')).data;
 expect(state.observations[0].rawRecord).toBeUndefined();expect(history.observations[0].invocation).toBeUndefined();
 const url=`/api/projects/self/observation-record?observationId=${observed.observationId}&rawHash=${digest(rawRecord)}`;
 const result=await f.request(url);expect(result.status).toBe(200);expect(result.data.rawRecord).toBe(rawRecord);expect(result.data.rawHash).toBe(digest(rawRecord));
 expect((await f.request(url.replace('self/','other/'))).status).toBe(404);
 expect((await f.request(url.replace(digest(rawRecord),'0'.repeat(64)))).status).toBe(409);
 expect((await f.request(url+'&path=main.ts')).status).toBeGreaterThanOrEqual(400);
 const w=await browser(f.request),button=[...w.document.querySelectorAll('#overall-diagnosis button')].find((n:any)=>n.textContent==='查看实际执行记录') as any;
 expect(button).toBeTruthy();await button.onclick();
 expect(w.document.querySelector('#dialog-body pre').textContent).toBe(rawRecord);
 expect(w.document.querySelector('#dialog-body').textContent).toContain(digest(rawRecord));
 expect(f.service.read('self').goals).toEqual(s.goals);expect(f.service.read('self').attempts).toHaveLength(0);
});

it('opens the complete current diagnosis and working source links when a round delivery is present',async()=>{
 const f=await fixture(),s=f.service.read('self'),before=s.mainlineAnnotations!.annotations.at(-1)!,ref=s.views[0].analysis.purposeRefs[0];
 s.views[0].analysis.diagnosis={scope:'workflow',certainty:'supported-hypothesis',scopeReason:'SCOPE_REASON_SENTINEL',conclusion:'WHOLE_DIAGNOSIS_SENTINEL',clauseIds:['goal'],journeys:[],evidence:[ref],counterEvidence:[ref],alternatives:[{explanation:'ALTERNATIVE_SENTINEL',refs:[ref],discriminatingObservation:'COMPARE_BEHAVIOR_SENTINEL'}],recommendation:{action:'ACTUAL_NEXT_STEP_SENTINEL',reason:'PRIORITY_REASON_SENTINEL',options:[],verificationJourney:'VERIFY_JOURNEY_SENTINEL'},taskAssessment:{reason:'TASK_REASON_SENTINEL',remaining:'REMAINING_SENTINEL'}} as any;
 f.service.store.save(s);
 const delivery={title:'A specific round report',goalConnection:'See the answer',before:'Hidden answer',after:'Visible answer',evidenceSummary:'No receipt yet',receiptIds:[],remaining:'Human understanding unknown',nextAction:'Inspect one answer',nextCheck:'Matches the request'};
 f.service.annotateMainline('self',{expectedRevision:s.mainlineAnnotations!.revision,idempotencyKey:'diagnosis-delivery',roundId:f.roundId,goalHash:before.goalHash,viewAttemptId:before.viewAttemptId,sourceHash:before.sourceHash,journeyId:before.journeyId,stepIds:before.stepIds,kind:'direct-product',reason:'Explain the round',expectedVerification:delivery.nextCheck,previousId:before.id,author:'developer',delivery});
 const w=await browser(f.request),d=w.document;d.querySelector('#overview-evidence').click();
 for(const expected of ['Show a useful answer','WHOLE_DIAGNOSIS_SENTINEL','SCOPE_REASON_SENTINEL','ALTERNATIVE_SENTINEL','ACTUAL_NEXT_STEP_SENTINEL','VERIFY_JOURNEY_SENTINEL'])expect(d.querySelector('#dialog-body').textContent).toContain(expected);
 const sourceButton=d.querySelector('#dialog-body .source-ref');expect(sourceButton).toBeTruthy();await sourceButton.onclick();
 expect(d.querySelector('#dialog-body').textContent).toContain('export const answer = 1;');
});

it('explains the actual round on the first screen, shares it across workspaces and keeps reader answers empty',async()=>{
 const f=await fixture(),state=(await f.request('/api/projects/self/state')).data,m=state.mainline.rounds[0];
 const delivery={title:'现在首页直接解释这一轮',goalConnection:'判断这一轮是否帮用户看到答案',before:'只看到代码变动',after:'直接看到这轮新增的答案',evidenceSummary:'尚未取得独立运行检查',receiptIds:[],remaining:'答案是否正确还不知道',nextAction:'先核对一条答案',nextCheck:'与用户要求一致才算有用'};
 const payload={expectedRevision:state.mainline.revision,idempotencyKey:'delivery-http',roundId:f.roundId,goalHash:m.goalHash,viewAttemptId:m.mapping.viewAttemptId,sourceHash:m.mapping.sourceHash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Explain the visible user change',expectedVerification:delivery.nextCheck,previousId:m.mapping.annotationId,author:'developer',delivery};
 expect((await f.request('/api/projects/self/mainline-annotate',payload)).status).toBe(200);
 const w=await browser(f.request),d=w.document,summary=d.querySelector('#overall-diagnosis .round-delivery');
 for(const text of Object.values(delivery).filter(v=>typeof v==='string'))expect(summary.textContent).toContain(text);
 expect(summary.textContent).toContain('尚未关联独立检查');expect(summary.textContent).not.toContain('限定通过');
 d.querySelector('#tab-rounds').click();expect(d.querySelector('#round-detail .round-delivery').textContent).toContain(delivery.after);
 d.querySelector('#tab-agents').click();expect(d.querySelector('#agent-turns .round-delivery').textContent).toContain(delivery.nextAction);
 d.querySelector('#tab-map').click();d.querySelector('#review-round').click();clickText(w,'#dialog-body button','2 本轮改善');
 expect(d.querySelector('.reader-context').textContent).toContain(delivery.before);expect(d.querySelector('#reader-answer').value).toBe('');
 d.querySelector('#close-dialog').click();d.querySelector('#correct-delivery').click();expect(d.querySelector('#delivery-correction').value).toBe('');d.querySelector('#delivery-correction').value='我仍不清楚这句话对应什么结果';
 await d.querySelector('#dialog-body form').onsubmit(new w.Event('submit',{cancelable:true}));
 expect(f.service.read('self').feedback.at(-1)?.originalText).toBe('我仍不清楚这句话对应什么结果');expect(f.service.read('self').attempts).toHaveLength(0);
 d.querySelector('#tab-rounds').click();clickText(w,'#round-detail button','修订关联');
 d.querySelector('[data-delivery-field="after"]').value='修订说明保留前版';const form=d.querySelector('#dialog-body form');form.querySelector('input:not([type=checkbox])').value='reviewer';
 await form.onsubmit(new w.Event('submit',{cancelable:true}));
 const reopened=await f.reopen(),annotations=reopened.read('self').mainlineAnnotations!.annotations;
 expect(annotations.at(-2)?.delivery?.after).toBe(delivery.after);expect(annotations.at(-1)?.delivery?.after).toBe('修订说明保留前版');
 expect(reopened.read('self').goals[0].originalText).toBe('Show a useful answer');expect(reopened.read('self').verificationReceipts||[]).toHaveLength(0);
});

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

it('shows a manually registered round explanation without pretending an automatic agent stream exists',async()=>{
 const f=await fixture(),s=f.service.read('self'),previous=s.mainlineAnnotations!.annotations.at(-1)!;s.agentActivity=undefined;f.service.store.save(s);
 const delivery={title:'A manually observed round',goalConnection:'Know the visible change',before:'Hidden answer',after:'Visible answer',evidenceSummary:'No independent receipt yet',receiptIds:[],remaining:'Automatic agent activity was not connected',nextAction:'Check the answer',nextCheck:'It matches the request'};
 f.service.annotateMainline('self',{expectedRevision:s.mainlineAnnotations!.revision,idempotencyKey:'manual-delivery',roundId:f.roundId,goalHash:previous.goalHash,viewAttemptId:previous.viewAttemptId,sourceHash:previous.sourceHash,journeyId:previous.journeyId,stepIds:previous.stepIds,kind:'direct-product',reason:'Explain the manual round',expectedVerification:delivery.nextCheck,previousId:previous.id,author:'developer',delivery});
 const w=await browser(f.request);w.document.querySelector('#tab-agents').click();
 expect(w.document.querySelector('.agent-round-explanation .round-delivery').textContent).toContain(delivery.after);
 expect(w.document.querySelector('#agent-turns').textContent).toContain('不是实时代理轨迹');expect(w.document.querySelectorAll('.agent-turn')).toHaveLength(0);
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

it('puts the latest round on the overview without treating source edits as product completion',async()=>{
 const {request}=await fixture(),w=await browser(request),host=w.document.querySelector('#overall-diagnosis');
 expect(host.textContent).toContain('最近登记一轮');
 expect(host.textContent).toContain('来源变化 · 产品结果待验证');
 expect(host.textContent).toContain('Make the answer visible');
 clickText(w,'#overall-diagnosis button','查看本轮前后与回执');
 expect(w.document.querySelector('#tab-rounds').getAttribute('aria-selected')).toBe('true');
 expect(w.document.querySelector('#round-detail').textContent).toContain('本轮前后');
});

it('keeps stale round evidence visible as stale when source changes',async()=>{
 const {request,source}=await fixture();appendFileSync(join(source,'main.ts'),'// source changed again\n');
 const w=await browser(request),host=w.document.querySelector('#overall-diagnosis');
 expect(host.textContent).toContain('旧关联待核对');
 expect(host.textContent).not.toContain('限定条件已验证');
});

it('renders scoped proof with its unknown baseline and keeps the overall recommendation independent',async()=>{
 const {request}=await fixture();
 // Presentation fixture only; binding and receipt eligibility are exercised by the core projection tests.
 const projected=async(path:string,payload?:unknown)=>{
  const response=await request(path,payload);
  if(path.endsWith('/state')){
   const progress=response.data.mainline.rounds.at(-1);
   progress.status='verified-scoped';
   progress.comparison.summary='此前未知 → 本轮 1 项限定通过；完整目标尚未验收。';
   response.data.closedLoop.nextAction='先核对整体用户旅程的共同阻碍';
  }
  return response;
 };
 const w=await browser(projected),host=w.document.querySelector('#overall-diagnosis');
 expect(host.textContent).toContain('限定条件已验证');
 expect(host.textContent).toContain('此前未知');
 expect(host.textContent).toContain('完整目标尚未验收');
 expect(host.textContent).toContain('先核对整体用户旅程的共同阻碍');
});

it('loads one durable session per polling request and still detects source edits on the next request',async()=>{
 const {service,source,request}=await fixture();
 const load=vi.spyOn(service.store,'load');
 for(const endpoint of ['state','history','activity','rounds','closed-loop']){
  load.mockClear();
  const response=await request(`/api/projects/self/${endpoint}`);
  expect(response.status).toBe(200);
  expect(load).toHaveBeenCalledTimes(1);
 }
 const before=(await request('/api/projects/self/state')).data;
 appendFileSync(join(source,'main.ts'),'// edit between refreshes\n');
 const after=(await request('/api/projects/self/state')).data;
 expect(after.closedLoop.sourceHash).not.toBe(before.closedLoop.sourceHash);
 expect(after.mainline.status).toBe('stale-source');
 expect(after.mainline.rounds).toHaveLength(before.mainline.rounds.length);
 expect(after.feedback).toEqual(before.feedback);
});

it('renders partial condition progress as a warning rather than a completed green badge',async()=>{
 const {request}=await fixture();
 const projected=async(path:string,payload?:unknown)=>{const response=await request(path,payload);if(path.endsWith('/state')){const p=response.data.mainline.rounds.at(-1);p.status='partial-verified';p.remaining='所选步骤确认条件 1/2 限定通过；第二项待验证';}return response;};
 const w=await browser(projected),host=w.document.querySelector('.mainline-round');
 expect(host.textContent).toContain('部分限定条件通过');
 expect(host.querySelector('.warn')).not.toBeNull();expect(host.querySelector('.good')).toBeNull();
});
it('shows why retained confirmation needs review instead of calling an old receipt current',async()=>{
 const f=await fixture(),s=f.service.read('self'),v=s.views[0],base={id:'confirmed-ui',goalHash:s.goals[0].hash,goalVersion:1,sourceHash:v.source.hash,analysisAttemptId:v.attemptId,status:'confirmed',author:'owner',createdAt:new Date().toISOString(),roundId:null,scenarios:[{id:'scenario-ui',title:'See answer',critical:'critical',given:'Request',when:'Read',then:'See answer',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'None',criteria:[{id:'criterion-ui',text:'Answer visible',observable:'Read answer',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'None'}]}]};
 const {hash}=await import('../../src/core/human-goal-workflow/types.js');s.scenarioSets=[{...base,hash:hash(base)} as any];s.views.push({...structuredClone(v),attemptId:'unrecorded-view'});s.currentView=1;f.service.store.save(s);
 const state=(await f.request('/api/projects/self/state')).data;expect(state.closedLoop.confirmationMapping.status).toBe('needs-review');
 const w=await browser(f.request);expect(w.document.querySelector('#closed-loop-summary').textContent).toContain('确认条件待重新核对');expect(w.document.querySelector('#closed-loop-summary').textContent).toContain('缺少真实分析接续记录');
 clickText(w,'button','实际验证与调用');expect(w.document.querySelector('#dialog-body').textContent).toContain('确认条件与当前分析');
});
