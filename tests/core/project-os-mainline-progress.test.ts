import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { projectMainlineProgress } from '../../src/core/human-goal-workflow/mainline-progress.js';
import { discoverSource } from '../../src/core/human-goal-workflow/source.js';
import { hash } from '../../src/core/human-goal-workflow/types.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();});
const at=(minute:number)=>`2026-09-23T00:${String(minute).padStart(2,'0')}:00.000Z`;
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mainline-progress-')),source=join(root,'source'),evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);
 writeFileSync(join(source,'a.ts'),'export const a = 1;\n');writeFileSync(join(source,'b.ts'),'export const b = 1;\n');writeFileSync(join(evidence,'stream.jsonl'),'');
 const config={projects:[{id:'self',label:'Fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 let service=new HumanGoalService(config,{revision:'unused',async analyze(){throw Error('provider must not run');}} as any,{dispatchRoundAnalysis:false});
 cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Deliver A and B',author:'owner',provenance:'fixture',clauses:[{id:'ca',text:'Deliver A',importance:'core'},{id:'cb',text:'Deliver B',importance:'core'}],analyze:false});
 const before=service.rounds.capture('self');
 for(const [id,clause,journey] of [['round-a','ca','ja'],['round-b','cb','jb']])service.rounds.enroll('self',{id:`registration-${id}`,projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',tool:'codex-exec',toolVersion:'0.155.0-alpha.9.2',taskId:id,roundId:id,attemptId:`attempt-${id}`,producerId:`producer-${id}`,mode:'live',goalHash:service.read('self').goals[0].hash,feedbackIds:[],purpose:`Develop ${id}`,clauseIds:[clause],journeyIds:[journey],selectedActionIds:[],acceptedPlan:null,beforeSnapshotId:before.id,stream:{rootIndex:0,path:'stream.jsonl'},deferredBenefit:null});
 appendFileSync(join(source,'a.ts'),'export const changed = true;\n');
 for(const id of ['round-a','round-b']){
  const regId=`registration-${id}`,after=service.rounds.checkpoint('self',regId);
  for(const [sequence,kind,description] of [[1,'begin','turn-start'],[2,'completed','turn-completed']] as const)
   service.rounds.accept('self',{key:`event-${id}-${sequence}`,projectId:'self',registrationId:regId,roundId:id,attemptId:`attempt-${id}`,producerId:`producer-${id}`,sequence,dependsOn:[],kind,description,rawHash:hash([id,sequence]),observedAt:new Date().toISOString(),sourceSnapshotId:sequence===2?after.id:null});
 }
 const current=discoverSource(service.project('self')),s=service.read('self'),ref=(path:string)=>{const f=current.files.find(f=>f.path===path)!;return {path,sha256:f.sha256,start:1,end:1};};
 const step=(id:string,title:string,target:string,clause:string,path:string)=>({id,title,purpose:title,actor:'user',responsibility:title,inputs:['input'],outputs:['output'],actual:'Source present',state:'source-supported',targetIds:[target],clauseIds:[clause],refs:[ref(path)],uncertainty:'Runtime unverified'});
 const journey=(id:string,title:string,stepValue:ReturnType<typeof step>,clause:string)=>({id,title,purpose:title,clauseIds:[clause],observed:{steps:[stepValue],links:[]},desired:{steps:[],links:[]}});
 s.views=[{generation:s.generation,attemptId:'view-current',source:current,goal:s.goals[0],analysis:{purpose:'A and B',purposeRefs:[],limitations:[],modules:[{id:'ma',title:'Module A',kind:'discovered',responsibility:'A',inputs:[],outputs:[],refs:[ref('a.ts')],supersedes:[]},{id:'mb',title:'Module B',kind:'discovered',responsibility:'B',inputs:[],outputs:[],refs:[ref('b.ts')],supersedes:[]}],edges:[],workflow:{status:'established',summary:'Two independent journeys',coverage:'registered-scope',unknowns:[],journeys:[journey('ja','Journey A',step('sa','Step A','ma','ca','a.ts'),'ca'),journey('jb','Journey B',step('sb','Step B','mb','cb','b.ts'),'cb')]},alignments:[],gaps:[],conflicts:[],changes:[],coverageNotes:'fixture',feedbackResponse:'fixture'},gaps:[],createdAt:new Date().toISOString(),status:'completed',changes:{goal:'',interpretation:'',source:'',ranking:'',evidence:''}} as any];s.currentView=0;service.store.save(s);
 const intent=(roundId:string,journeyId:string,stepId:string,extra={})=>({expectedRevision:service.read('self').mainlineAnnotations?.revision??0,idempotencyKey:`key-${roundId}-${service.read('self').mainlineAnnotations?.revision??0}`,roundId,goalHash:service.read('self').goals[0].hash,viewAttemptId:'view-current',sourceHash:current.hash,journeyId,stepIds:[stepId],kind:'direct-product',reason:'Advance this user step',expectedVerification:'Check the matching observable condition',previousId:service.read('self').mainlineAnnotations?.annotations.filter(a=>a.roundId===roundId).at(-1)?.id??null,author:'owner',...extra});
 return {service,source,evidence,root,config,current,intent,reopen:async()=>{await service.close();service=new HumanGoalService(config,{revision:'unused',async analyze(){throw Error('provider must not run');}} as any,{dispatchRoundAnalysis:false});return service;}};
}
function addConfirmation(service:HumanGoalService,sourceHash:string){
 const s=service.read('self'),criterion=(id:string,journey:string,target:string,clause:string)=>({id,text:`Verify ${id}`,observable:`Observe ${id}`,clauseIds:[clause],journeyIds:[journey],targetIds:[target],mapping:'mapped',uncertainty:'none'});
 const scenarios=[['a','ja','ma','ca'],['b','jb','mb','cb']].map(([id,journey,target,clause])=>({id:`scenario-${id}`,title:`Scenario ${id}`,critical:'critical',given:'Given',when:'When',then:'Then',clauseIds:[clause],journeyIds:[journey],targetIds:[target],mapping:'mapped',uncertainty:'none',criteria:[criterion(`criterion-${id}`,journey,target,clause)]}));
 const base={id:'confirmation',goalHash:s.goals[0].hash,goalVersion:1,sourceHash,analysisAttemptId:'view-current',scenarios,status:'confirmed',author:'owner',createdAt:at(0),roundId:null};
 s.scenarioSets=[{...base,hash:hash(base)} as any];service.store.save(s);
}
function receipt(service:HumanGoalService,roundId:string,criterionId:string,status:string,id:string,start:number,end:number){
 const context=service.verificationContext('self',roundId),binding=context.binding,criterion=binding.criteria.find(c=>c.criterionId===criterionId)!;
 return {schema:'project-os.verification.v1',id,binding,startedAt:at(start),endedAt:at(end),sourceAfterHash:binding.sourceHash,sourceChanged:false,checks:[{id:'check',configHash:hash('same-check'),argv:['fixture-check'],cwd:service.project('self').sourceRoot,startedAt:at(start),endedAt:at(end),preflight:[],exitCode:status==='passed'?0:1,signal:null,stdout:'',stderr:'',executionError:null,assertions:[{...criterion,assertionId:criterionId,status,actual:'Observed',evidence:'Fixture condition'}],traces:[]}],hash:hash([id,status])} as any;
}

it('keeps unknown work as a candidate, then saves a confirmed association and append-only correction across restart',async()=>{
 const f=await fixture(),initial=projectMainlineProgress(f.service.read('self'),f.current.hash);
 expect(initial.rounds[0].status).toBe('unmapped');expect(initial.rounds[0].candidates).toMatchObject([{journeyId:'ja',stepId:'sa'}]);
 const firstRequest=f.intent('round-a','ja','sa'),first=f.service.annotateMainline('self',firstRequest);
 expect(f.service.annotateMainline('self',firstRequest)).toEqual(first);
 expect(()=>f.service.annotateMainline('self',{...firstRequest,reason:'Changed under same key'})).toThrow('同一请求键');
 const corrected=f.service.annotateMainline('self',f.intent('round-a','ja','sa',{kind:'support-infrastructure',reason:'Remove an obstacle before the user step'}));
 expect(corrected.revision).toBe(2);expect(f.service.read('self').mainlineAnnotations?.annotations).toHaveLength(2);
 const priorHash=hash(f.service.read('self'));projectMainlineProgress(f.service.read('self'),f.current.hash);expect(hash(f.service.read('self'))).toBe(priorHash);
 const reopened=await f.reopen(),after=projectMainlineProgress(reopened.read('self'),f.current.hash);
 expect(after.rounds[0].mapping).toMatchObject({state:'confirmed',kind:'support-infrastructure',annotationId:corrected.annotationId});
 expect(after.annotations).toHaveLength(2);
});

it('rejects unresolved references and stale versions without altering the saved goal or native round',async()=>{
 const f=await fixture(),base=f.intent('round-a','ja','sa'),before=hash(f.service.read('self'));
 for(const changed of [{journeyId:'missing'},{stepIds:['missing']},{roundId:'missing'},{sourceHash:hash('old')},{viewAttemptId:'old-view'},{goalHash:hash('old')},{previousId:'unknown'}])
  expect(()=>f.service.annotateMainline('self',{...base,...changed})).toThrow();
 expect(hash(f.service.read('self'))).toBe(before);
 f.service.annotateMainline('self',base);
 const sourceChanged=join(f.source,'a.ts');appendFileSync(sourceChanged,'// next version\n');
 const stale=projectMainlineProgress(f.service.read('self'),discoverSource(f.service.project('self')).hash);
 expect(stale.rounds[0].status).toBe('stale');expect(stale.rounds[0].steps).toEqual([]);
 expect(()=>f.service.annotateMainline('self',f.intent('round-b','jb','sb'))).toThrow();
});

it('keeps saved annotations as history when the analysis view or human goal changes',async()=>{
 const f=await fixture();f.service.annotateMainline('self',f.intent('round-a','ja','sa'));
 let s=f.service.read('self');s.views.push({...s.views[0],attemptId:'view-new'});s.currentView=1;f.service.store.save(s);
 let p=projectMainlineProgress(f.service.read('self'),f.current.hash);expect(p.rounds[0].mapping.state).toBe('stale');expect(p.rounds[0].steps).toEqual([]);
 expect(p.rounds[0].mapping.intentRelation).toBe('pending-remap');expect(p.rounds[0].intentSteps[0].title).toBe('Step A');
 expect(p.journeys[0].steps[0].work).toEqual([]);
 s=f.service.read('self');f.service.feedback('self',{expectedGeneration:s.generation,idempotencyKey:'goal-revision',kind:'desired-change',originalText:'New human goal',author:'owner',provenance:'fixture',analyze:false});
 p=projectMainlineProgress(f.service.read('self'),f.current.hash);expect(p.rounds[0].mapping.state).toBe('stale');expect(p.annotations).toHaveLength(1);
 expect(p.rounds[0].mapping.intentRelation).toBe('old-goal');expect(p.journeys).toEqual([]);
});

it('isolates two journeys and rounds; reports and source edits stay unverified until matching current condition receipts',async()=>{
 const f=await fixture();f.service.annotateMainline('self',f.intent('round-a','ja','sa'));f.service.annotateMainline('self',f.intent('round-b','jb','sb'));
 let p=projectMainlineProgress(f.service.read('self'),f.current.hash);
 expect(p.rounds.map(r=>r.status)).toEqual(['changed-unverified','intent-only']);
 expect(p.journeys[0].steps[0].work.map(w=>w.roundId)).toEqual(['round-a']);expect(p.journeys[1].steps[0].work.map(w=>w.roundId)).toEqual(['round-b']);
 addConfirmation(f.service,f.current.hash);let s=f.service.read('self');s.verificationReceipts=[receipt(f.service,'round-a','criterion-a','passed','pass-a',1,2),receipt(f.service,'round-b','criterion-b','unknown','unknown-b',1,2)];f.service.store.save(s);
 p=projectMainlineProgress(f.service.read('self'),f.current.hash);expect(p.rounds.map(r=>r.status)).toEqual(['verified-scoped','intent-only']);
 s=f.service.read('self');s.verificationReceipts!.push(receipt(f.service,'round-b','criterion-b','behavior-failed','fail-b',3,4));f.service.store.save(s);
 p=projectMainlineProgress(f.service.read('self'),f.current.hash);expect(p.rounds.map(r=>r.status)).toEqual(['verified-scoped','failed-blocked']);
 s=f.service.read('self');s.verificationReceipts!.push(receipt(f.service,'round-a','criterion-a','behavior-failed','latest-fail-a',3,4));f.service.store.save(s);
 p=projectMainlineProgress(f.service.read('self'),f.current.hash);expect(p.rounds.map(r=>r.status)).toEqual(['failed-blocked','failed-blocked']);
});

it('does not lend a receipt across journeys that reuse the same target and clause',async()=>{
 const f=await fixture();f.service.annotateMainline('self',f.intent('round-a','ja','sa'));addConfirmation(f.service,f.current.hash);
 let s=f.service.read('self'),set=s.scenarioSets![0],other=set.scenarios[1];
 other.targetIds=['ma'];other.clauseIds=['ca'];other.criteria[0].targetIds=['ma'];other.criteria[0].clauseIds=['ca'];
 const {hash:oldHash,...confirmation}=set;set.hash=hash(confirmation);f.service.store.save(s);
 s=f.service.read('self');s.verificationReceipts=[receipt(f.service,'round-a','criterion-b','passed','other-journey-pass',1,2)];f.service.store.save(s);
 let p=projectMainlineProgress(f.service.read('self'),f.current.hash);
 expect(p.rounds[0].status).not.toBe('verified-scoped');expect(p.rounds[0].steps[0].conditions).toEqual([]);
 expect(p.rounds[0].remaining).toContain('0/1');expect(p.rounds[0].remaining).not.toContain('1/2');
 s=f.service.read('self');s.verificationReceipts!.push(receipt(f.service,'round-a','criterion-a','passed','same-journey-pass',3,4));f.service.store.save(s);
 p=projectMainlineProgress(f.service.read('self'),f.current.hash);
 expect(p.rounds[0].status).toBe('verified-scoped');expect(p.rounds[0].steps[0].conditions.map(c=>c.criterionId)).toEqual(['criterion-a']);
 expect(p.rounds[0].remaining).toContain('1/1');
});

it('keeps a version-bound historical intent after a source edit without restoring proof',async()=>{
 const f=await fixture();addConfirmation(f.service,f.current.hash);
 let s=f.service.read('self');s.verificationReceipts=[receipt(f.service,'round-a','criterion-a','passed','old-pass',1,2)];f.service.store.save(s);
 appendFileSync(join(f.source,'a.ts'),'// newer source\n');const current=discoverSource(f.service.project('self'));
 const oldRequest=f.intent('round-a','ja','sa');
 expect(()=>f.service.annotateMainline('self',oldRequest)).toThrow();
 const request={...oldRequest,interpretationMode:'historical-intent',observedSourceHash:f.current.hash,expectedCurrentSourceHash:current.hash};
 expect(()=>f.service.annotateMainline('self',{...request,expectedCurrentSourceHash:hash('wrong')})).toThrow();
 expect(()=>f.service.annotateMainline('self',{...request,observedSourceHash:hash('wrong')})).toThrow();
 expect(()=>f.service.annotateMainline('self',{...request,viewAttemptId:'not-saved'})).toThrow();
 const saved=f.service.annotateMainline('self',request);
 let p=projectMainlineProgress(f.service.read('self'),current.hash);
 expect(p.status).toBe('stale-source');expect(p.rounds[0].steps).toEqual([]);expect(p.rounds[0].proofEligible).toBe(false);
 expect(p.rounds[0].intentSteps).toMatchObject([{id:'sa',title:'Step A',purpose:'Step A'}]);
 expect(p.rounds[0].mapping).toMatchObject({state:'stale',intentRelation:'reference-visible',annotationId:saved.annotationId});
 expect(p.journeys[0].feed[0]).toMatchObject({roundId:'round-a',status:'stale'});
 writeFileSync(join(f.source,'a.ts'),'export const a = 1;\nexport const changed = true;\n');
 const restored=discoverSource(f.service.project('self'));expect(restored.hash).toBe(f.current.hash);
 p=projectMainlineProgress(f.service.read('self'),restored.hash);expect(p.status).toBe('current');expect(p.rounds[0].mapping.state).toBe('stale');expect(p.rounds[0].steps).toEqual([]);
 const reopened=await f.reopen();p=projectMainlineProgress(reopened.read('self'),restored.hash);
 expect(p.rounds[0].intentSteps[0].title).toBe('Step A');expect(p.rounds[0].steps).toEqual([]);
});

it('connects a selected current journey and step but refuses stale or unknown connection intent',async()=>{
 const f=await fixture(),s=f.service.read('self'),mainlineIntent={viewAttemptId:'view-current',sourceHash:f.current.hash,journeyId:'ja',stepIds:['sa'],kind:'direct-product',reason:'Complete step A',expectedVerification:'Check criterion A'};
 const request={id:'connection',projectId:'self',repoRoot:f.source,worktreeRoot:f.source,branch:'fixture',format:'codex-exec-jsonl',toolVersion:'0.155.0-alpha.9.2',taskId:'task',goalHash:s.goals[0].hash,purpose:'Develop A',clauseIds:['ca'],journeyIds:['ja'],selectedActionIds:[],stream:{rootIndex:0,path:'stream.jsonl'},start:'from-now',mainlineIntent};
 expect(()=>f.service.activity.connect('self',{...request,mainlineIntent:{...mainlineIntent,stepIds:['missing']}})).toThrow();
 expect(()=>f.service.activity.connect('self',{...request,journeyIds:['jb']})).toThrow();
 expect(f.service.activity.connect('self',request).mainlineIntent).toMatchObject({journeyId:'ja',stepIds:['sa']});
 appendFileSync(join(f.evidence,'stream.jsonl'),[{type:'thread.started',thread_id:'thread'},{type:'turn.started',turn_id:'turn-one'},{type:'turn.completed',turn_id:'turn-one'}].map(value=>JSON.stringify(value)+'\n').join(''));
 f.service.activity.poll('self','connection');const progress=projectMainlineProgress(f.service.read('self'),f.current.hash);
 expect(progress.rounds.at(-1)?.mapping).toMatchObject({state:'confirmed',origin:'connection',journeyId:'ja',stepIds:['sa']});
 expect(progress.rounds.at(-1)?.status).toBe('intent-only');
});
