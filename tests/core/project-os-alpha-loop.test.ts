import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { discoverSource } from '../../src/core/human-goal-workflow/source.js';
import { projectMainlineProgress } from '../../src/core/human-goal-workflow/mainline-progress.js';
import { hash } from '../../src/core/human-goal-workflow/types.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();});
async function fixture(options:{priorRound?:boolean;priorFailure?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'alpha-loop-')),source=join(root,'source'),evidence=join(root,'evidence');mkdirSync(source);mkdirSync(evidence);
 writeFileSync(join(source,'main.ts'),'export const answer = false;\n');writeFileSync(join(evidence,'stream.jsonl'),'');
 const config={projects:[{id:'self',label:'Fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case',evidenceRoots:[evidence]}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}};
 let service=new HumanGoalService(config,{revision:'fixture',async analyze(){throw Error('provider not used');}} as any,{dispatchRoundAnalysis:false});
 cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Show a correct answer',author:'owner',provenance:'fixture',clauses:[{id:'goal',text:'Show the answer',importance:'core'}],analyze:false});
 const goal=service.read('self').goals[0];
 const publish=(id:string)=>{const snapshot=discoverSource(service.project('self')),file=snapshot.files[0],ref={path:'main.ts',sha256:file.sha256,start:1,end:1},s=service.read('self');
  const criterion={id:'criterion',text:'Reader sees the correct answer',observable:'Read rendered answer',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'none'};
  const scenario={id:'scenario',title:'Read answer',critical:'critical',given:'Page open',when:'Read',then:'Correct',clauseIds:['goal'],journeyIds:['journey'],targetIds:['answer'],mapping:'mapped',uncertainty:'none',criteria:[criterion]};
  const step={id:'step',title:'Render answer',purpose:'Show answer',actor:'user',responsibility:'read',inputs:['request'],outputs:['answer'],actual:'Source present',state:'source-supported',targetIds:['answer'],clauseIds:['goal'],refs:[ref],uncertainty:'Runtime unknown'};
  s.views.push({generation:s.generation,attemptId:id,source:snapshot,goal,analysis:{purpose:'Show answer',purposeRefs:[ref],limitations:[],modules:[{id:'answer',title:'Answer',kind:'discovered',responsibility:'Show answer',inputs:[],outputs:[],refs:[ref],supersedes:[]}],edges:[],workflow:{status:'established',summary:'Read',coverage:'registered-scope',unknowns:[],journeys:[{id:'journey',title:'Read answer',purpose:'See answer',clauseIds:['goal'],observed:{steps:[step],links:[]},desired:{steps:[],links:[]}}]},alignments:[],gaps:[],conflicts:[],changes:[],coverageNotes:'fixture',feedbackResponse:'fixture'},gaps:[],createdAt:new Date().toISOString(),status:'completed',changes:{goal:'',interpretation:'',source:'',ranking:'',evidence:''}} as any);s.currentView=s.views.length-1;
  const base={id:`confirmation-${id}`,goalHash:goal.hash,goalVersion:goal.version,sourceHash:snapshot.hash,analysisAttemptId:id,scenarios:[scenario],status:'confirmed',author:'owner',createdAt:new Date().toISOString(),roundId:null};(s.scenarioSets??=[]).push({...base,hash:hash(base)} as any);service.store.save(s);return snapshot;};
 const makeReceipt=(id:string,status:'passed'|'behavior-failed'|'environment-blocked'|'missing-capability'|'unknown',roundId='round')=>{const binding=service.verificationContext('self',roundId).binding,criterion=binding.criteria[0];return {id,binding,sourceAfterHash:binding.sourceHash,sourceChanged:false,checks:[{id:'check',configHash:hash('check'),startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),assertions:[{...criterion,assertionId:'answer',status,actual:'Observed answer',evidence:'Independent fixture check'}],traces:[]}],startedAt:new Date().toISOString(),endedAt:new Date().toISOString()} as any;};
 const saveReceipt=(r:any)=>{const s=service.read('self');(s.verificationReceipts??=[]).push(r);service.store.save(s);};
 const original=publish('before');
 if(options.priorRound||options.priorFailure){
  const prior=service.rounds.capture('self');
  service.rounds.enroll('self',{id:'prior-registration',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',tool:'codex-exec',toolVersion:'0.155.0-alpha.9.2',taskId:'prior-task',roundId:'prior-round',attemptId:'prior-attempt',producerId:'prior-producer',mode:'live',goalHash:goal.hash,feedbackIds:[],purpose:'Check existing answer',clauseIds:['goal'],journeyIds:['journey'],selectedActionIds:[],acceptedPlan:null,beforeSnapshotId:prior.id,stream:{rootIndex:0,path:'stream.jsonl'},deferredBenefit:null});
  service.rounds.checkpoint('self','prior-registration');
  if(options.priorFailure){saveReceipt(makeReceipt('before-fail','behavior-failed','prior-round'));await new Promise(resolve=>setTimeout(resolve,5));}
 }
 const before=service.rounds.capture('self');
 service.rounds.enroll('self',{id:'registration',projectId:'self',repoRoot:source,worktreeRoot:source,branch:'fixture',tool:'codex-exec',toolVersion:'0.155.0-alpha.9.2',taskId:'task',roundId:'round',attemptId:'attempt',producerId:'producer',mode:'live',goalHash:goal.hash,feedbackIds:[],purpose:'Make answer correct',clauseIds:['goal'],journeyIds:['journey'],selectedActionIds:[],acceptedPlan:null,beforeSnapshotId:before.id,stream:{rootIndex:0,path:'stream.jsonl'},deferredBenefit:null});
 const finish=(change=true)=>{if(change)appendFileSync(join(source,'main.ts'),'export const fixed = true;\n');const after=service.rounds.checkpoint('self','registration');for(const [sequence,kind,description] of [[1,'begin','turn-start'],[2,'completed','turn-completed']] as const)service.rounds.accept('self',{key:`event-${sequence}`,projectId:'self',registrationId:'registration',roundId:'round',attemptId:'attempt',producerId:'producer',sequence,dependsOn:[],kind,description,rawHash:hash(sequence),observedAt:new Date().toISOString(),sourceSnapshotId:sequence===2?after.id:null});const current=publish('after');service.annotateMainline('self',{expectedRevision:0,idempotencyKey:'map',roundId:'round',goalHash:goal.hash,viewAttemptId:'after',sourceHash:current.hash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Fix answer',expectedVerification:'Reader sees correct answer',previousId:null,author:'owner'});return current;};
 return {get service(){return service;},source,goal,original,finish,makeReceipt,saveReceipt,reopen:async()=>{await service.close();service=new HumanGoalService(config,{revision:'fixture',async analyze(){throw Error('provider not used');}} as any,{dispatchRoundAnalysis:false});return service;}};
}

it('shows unknown before separately from a matching after receipt and source change',async()=>{
 const f=await fixture(),after=f.finish();f.saveReceipt(f.makeReceipt('after-pass','passed'));
 const round=projectMainlineProgress(f.service.read('self'),after.hash).rounds[0];
 expect(round.comparison.state).toBe('unknown-before');
 expect(round.comparison.criteria[0]).toMatchObject({before:{status:'unknown',receiptIds:[]},after:{status:'passed',receiptIds:['after-pass']},transition:'new-evidence'});
 expect(round.comparison.sourceChanges.map(c=>c.path)).toEqual(['main.ts']);
 expect(round.comparison.summary).toContain('此前');
});

it('compares independent failure then pass, retains both receipts and survives reopen',async()=>{
 const f=await fixture({priorFailure:true}),after=f.finish();f.saveReceipt(f.makeReceipt('after-pass','passed'));
 let round=projectMainlineProgress(f.service.read('self'),after.hash).rounds.find(r=>r.roundId==='round')!;
 expect(round.comparison.state).toBe('comparable');
 expect(round.comparison.criteria[0]).toMatchObject({before:{status:'behavior-failed',receiptIds:['before-fail']},after:{status:'passed',receiptIds:['after-pass']},transition:'resolved'});
 expect(round.comparison.resolved).toContain('Reader sees the correct answer');
 expect(f.service.read('self').verificationReceipts?.map(r=>r.id)).toEqual(['before-fail','after-pass']);
 await f.reopen();round=projectMainlineProgress(f.service.read('self'),after.hash).rounds.find(r=>r.roundId==='round')!;
 expect(round.comparison.criteria[0].transition).toBe('resolved');
});

it('does not carry proof across goal, criterion, source or view remapping',async()=>{
 const f=await fixture({priorFailure:true}),after=f.finish();
 const pass=f.makeReceipt('after-pass','passed');f.saveReceipt(pass);
 let s=f.service.read('self');const previous=s.scenarioSets![0];previous.scenarios[0].criteria[0].text='Different criterion';f.service.store.save(s);
 const current=()=>projectMainlineProgress(f.service.read('self'),after.hash).rounds.find(r=>r.roundId==='round')!;
 let comparison=current().comparison;
 expect(comparison.state).toBe('incomparable');expect(comparison.criteria[0].transition).toBe('incomparable');
 s=f.service.read('self');s.scenarioSets![0].scenarios[0].criteria[0].text='Reader sees the correct answer';s.verificationReceipts![1].sourceAfterHash=f.original.hash;f.service.store.save(s);
 comparison=current().comparison;
 expect(comparison.criteria[0].after.status).toBe('unknown');
 s=f.service.read('self');s.views.push({...s.views.at(-1)!,attemptId:'after-new'});s.currentView=s.views.length-1;f.service.store.save(s);
 expect(current().mapping.intentRelation).toBe('pending-remap');
 expect(current().comparison.state).toBe('incomparable');
 f.service.feedback('self',{expectedGeneration:f.service.read('self').generation,idempotencyKey:'new-goal',kind:'desired-change',originalText:'A different goal',author:'owner',provenance:'fixture',analyze:false});
 expect(current().comparison).toMatchObject({state:'incomparable',confirmationId:null});
});

it('does not count this round’s same-source after receipt as development-before evidence',async()=>{
 const f=await fixture(),after=f.finish(false);f.saveReceipt(f.makeReceipt('same-source-pass','passed'));
 const comparison=projectMainlineProgress(f.service.read('self'),after.hash).rounds[0].comparison;
 expect(comparison.state).toBe('unknown-before');
 expect(comparison.criteria[0]).toMatchObject({before:{status:'unknown',receiptIds:[]},after:{status:'passed',receiptIds:['same-source-pass']},transition:'new-evidence'});
});

it('keeps a same-source current pass out of before after a later checkpoint',async()=>{
 const f=await fixture();const first=f.service.rounds.checkpoint('self','registration');
 for(const [sequence,kind,description] of [[1,'begin','turn-start'],[2,'completed','turn-completed']] as const)f.service.rounds.accept('self',{key:`event-${sequence}`,projectId:'self',registrationId:'registration',roundId:'round',attemptId:'attempt',producerId:'producer',sequence,dependsOn:[],kind,description,rawHash:hash(sequence),observedAt:new Date().toISOString(),sourceSnapshotId:first.id});
 f.service.annotateMainline('self',{expectedRevision:0,idempotencyKey:'same-map',roundId:'round',goalHash:f.goal.hash,viewAttemptId:'before',sourceHash:f.original.hash,journeyId:'journey',stepIds:['step'],kind:'direct-product',reason:'Verify existing answer',expectedVerification:'Reader sees correct answer',previousId:null,author:'owner'});
 f.saveReceipt(f.makeReceipt('new-current-proof','passed'));
 await new Promise(resolve=>setTimeout(resolve,5));f.service.rounds.checkpoint('self','registration');
 const comparison=projectMainlineProgress(f.service.read('self'),f.original.hash).rounds[0].comparison;
 expect(comparison.state).toBe('unknown-before');
 expect(comparison.criteria[0]).toMatchObject({before:{status:'unknown',receiptIds:[]},after:{status:'passed',receiptIds:['new-current-proof']},transition:'new-evidence'});
});

it('does not reclassify a later prior-round check as before after a same-source checkpoint',async()=>{
 const f=await fixture({priorRound:true}),after=f.finish(false);
 f.saveReceipt(f.makeReceipt('late-prior-pass','passed','prior-round'));
 f.saveReceipt(f.makeReceipt('current-pass','passed'));
 await new Promise(resolve=>setTimeout(resolve,5));f.service.rounds.checkpoint('self','registration');
 const comparison=projectMainlineProgress(f.service.read('self'),after.hash).rounds.find(r=>r.roundId==='round')!.comparison;
 expect(comparison.state).toBe('unknown-before');
 expect(comparison.criteria[0]).toMatchObject({before:{status:'unknown',receiptIds:[]},after:{status:'passed',receiptIds:['current-pass']},transition:'new-evidence'});
});

it('keeps an imported baseline without a fixed observation time incomparable while retaining current proof',async()=>{
 const f=await fixture(),after=f.finish(false);f.saveReceipt(f.makeReceipt('current-pass','passed'));
 const s=f.service.read('self'),baseline=s.rounds!.snapshots.find(snapshot=>snapshot.id===s.rounds!.registrations[0].binding.beforeSnapshotId)!;
 baseline.kind='historical-import';baseline.observedAt=null;f.service.store.save(s);
 const comparison=projectMainlineProgress(f.service.read('self'),after.hash).rounds[0].comparison;
 expect(comparison.state).toBe('incomparable');
 expect(comparison.criteria[0]).toMatchObject({before:{status:'unknown',receiptIds:[],comparable:false},after:{status:'passed',receiptIds:['current-pass']},transition:'incomparable'});
});
