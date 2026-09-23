import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { HumanGoalService } from '../src/core/human-goal-workflow/service.js';
import { runVerification, type VerificationContext } from '../src/core/human-goal-workflow/verification.js';
import { configSchema, digest, hash } from '../src/core/human-goal-workflow/types.js';
const args=process.argv.slice(2),flag=(name:string)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
// A bounded self-case service interaction check. It proves only these named observations.
export async function probeState(url:string,id:string,fetcher:typeof fetch=fetch,emit=(assertionId:string,status:string,actual:string,evidence:string)=>console.log('PROJECT_OS_ASSERTION '+JSON.stringify({assertionId,status,actual,evidence}))){
 const origin=new URL(url);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Only loopback URL allowed');
 const read=async(path:string,assertionId:string)=>{
  let response:Response;
  try{response=await fetcher(`${origin.origin}${path}`);}catch(e){emit(assertionId,'environment-blocked','Loopback connection unavailable',String(e));return null;}
  let raw:string;
  try{raw=await response.text();}catch(e){emit(assertionId,'unknown','Response body unreadable',String(e));return null;}
  if(!response.ok){emit(assertionId,'behavior-failed',`HTTP ${response.status}`,raw||'Empty error response');return null;}
  try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected response object');return value;}catch(e){emit(assertionId,'behavior-failed','Malformed service JSON',`${String(e)}; raw=${raw}`);return null;}
 };
 const state=await read(`/api/projects/${encodeURIComponent(id)}/state`,'confirmed-goal');
 if(!state){emit('source-reference','unknown','No valid current state','Source request not attempted');return;}
 const goal=Array.isArray(state.goals)?state.goals.at(-1):null,confirmed=state.closedLoop?.confirmation;
 emit('confirmed-goal',goal&&typeof goal.hash==='string'&&goal.hash.length>0&&Number.isInteger(goal.version)&&goal.version>0&&confirmed?.status==='confirmed'&&confirmed?.goalHash===goal.hash&&confirmed?.goalVersion===goal.version?'passed':'behavior-failed','Read current goal and scenario confirmation',JSON.stringify({goalHash:goal?.hash??null,confirmationHash:confirmed?.hash??null,goalVersion:goal?.version??null}));
 const view=state.views?.[state.currentView],ref=view?.analysis?.purposeRefs?.[0];if(!ref){emit('source-reference','unknown','No referenced source','No source request attempted');return;}
 const value=await read(`/api/projects/${encodeURIComponent(id)}/source?path=${encodeURIComponent(ref.path)}&sha256=${ref.sha256}&start=${ref.start}&end=${ref.end}`,'source-reference');
 if(value)emit('source-reference',value.sha256===ref.sha256&&typeof value.text==='string'&&value.text.length>0?'passed':'behavior-failed','Read source response',JSON.stringify({path:ref.path,expectedHash:ref.sha256,returnedHash:value.sha256??null}));
}
// Read-only loopback probe for one selected round. Each assertion is checked
// against a distinct service field or endpoint, without creating evidence.
export async function probeMainline(url:string,id:string,selectedRound?:string,fetcher:typeof fetch=fetch,emit=(assertionId:string,status:string,actual:string,evidence:string)=>console.log('PROJECT_OS_ASSERTION '+JSON.stringify({assertionId,status,actual,evidence}))){
 const origin=new URL(url);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Only loopback URL allowed');
 const base=`${origin.origin}/api/projects/${encodeURIComponent(id)}`;
 const read=async(path:string)=>{try{const response=await fetcher(`${base}/${path}`),raw=await response.text();if(!response.ok)return {value:null,error:`HTTP ${response.status}: ${raw.slice(0,240)}`};const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected object');return {value,error:null};}catch(e){return {value:null,error:String(e)};}};
 const stateRead=await read('state'),state:any=stateRead.value;
 if(!state){for(const assertionId of ['alpha-round-goal','alpha-mainline-association','alpha-before-after','alpha-projection-consistency','alpha-source-reference','alpha-context-binding','alpha-receipt-bindings'])emit(assertionId,'unknown','Cannot inspect selected round',stateRead.error||'State unavailable');return;}
 const goal=state.goals?.at(-1),round=state.rounds?.rounds?.find((r:any)=>r.id===(selectedRound||state.rounds?.rounds?.at(-1)?.id)),progress=state.mainline?.rounds?.find((r:any)=>r.roundId===round?.id),view=state.views?.[state.currentView],comparison=progress?.comparison;
 const roundOk=!!round&&!!goal&&round.goalHash===goal.hash&&!!round.before&&!!round.after&&round.proofEligible===true;
 emit('alpha-round-goal',roundOk?'passed':'behavior-failed',round?`Selected round ${round.id}`:'Selected round missing',JSON.stringify({requested:selectedRound??null,roundId:round?.id??null,goalVersion:goal?.version??null,boundGoal:round?.goalHash??null,currentGoal:goal?.hash??null,proofEligible:round?.proofEligible??null}));
 const journey=view?.analysis?.workflow?.journeys?.find((j:any)=>j.id===progress?.mapping?.journeyId),steps=journey?.observed?.steps?.filter((s:any)=>progress?.mapping?.stepIds?.includes(s.id))??[];
 const associationOk=!!progress&&progress.mapping.state==='confirmed'&&progress.goalHash===goal?.hash&&progress.mapping.referenceGoalVersion===goal?.version&&progress.mapping.observedSourceHash===round?.after?.sourceHash&&progress.mapping.viewAttemptId===view?.attemptId&&progress.mapping.sourceHash===view?.source?.hash&&progress.mapping.sourceHash===state.mainline?.sourceHash&&steps.length===progress.mapping.stepIds.length&&progress.mapping.stepIds.length>0&&!!progress.mapping.reason&&!!progress.mapping.expectedVerification&&(!progress.mapping.annotationId||state.mainline?.annotations?.some((a:any)=>a.id===progress.mapping.annotationId&&a.roundId===round?.id));
 emit('alpha-mainline-association',associationOk?'passed':'behavior-failed',associationOk?'Current association resolved':'Current association missing or stale',JSON.stringify({roundId:round?.id??null,journeyId:progress?.mapping?.journeyId??null,stepCount:steps.length,annotationId:progress?.mapping?.annotationId??null}));
 const expectedChanges=round?.deltas?.map((d:any)=>[d.path,d.kind,d.before,d.after])??[],shownChanges=comparison?.sourceChanges?.map((d:any)=>[d.path,d.kind,d.before,d.after])??[];
 const comparisonOk=!!comparison&&comparison.beforeSourceHash===round?.before?.sourceHash&&comparison.afterSourceHash===round?.after?.sourceHash&&comparison.goalHash===round?.goalHash&&hash(expectedChanges)===hash(shownChanges)&&typeof comparison.summary==='string'&&comparison.summary.length>0&&typeof comparison.nextReason==='string'&&comparison.nextReason.length>0&&Array.isArray(comparison.criteria);
 emit('alpha-before-after',comparisonOk?'passed':'behavior-failed',comparisonOk?'Source-bound round comparison present':'Comparison does not match round observations',JSON.stringify({roundId:round?.id??null,before:comparison?.beforeSourceHash??null,after:comparison?.afterSourceHash??null,changeCount:shownChanges.length,criterionCount:comparison?.criteria?.length??null,state:comparison?.state??null}));
 const activityRead=await read('activity'),activity:any=activityRead.value,activityRound=activity?.mainline?.rounds?.find((r:any)=>r.roundId===round?.id),turn=activity?.turns?.find((t:any)=>t.roundId===round?.id);
 const projectionOk=!!activityRound&&!!turn&&hash(activityRound)===hash(progress)&&hash(turn.mainline)===hash(progress);
 emit('alpha-projection-consistency',activityRead.error?'unknown':projectionOk?'passed':'behavior-failed',projectionOk?'State, activity and turn agree':'State, activity or selected turn disagree',JSON.stringify({roundId:round?.id??null,activityError:activityRead.error,turnId:turn?.turnId??null}));
 const sourceFile=comparison?.sourceChanges?.find((c:any)=>c.after&&view?.source?.files?.some((f:any)=>f.path===c.path&&f.sha256===c.after));
 const ref=sourceFile?{path:sourceFile.path,sha256:sourceFile.after,start:1,end:20}:view?.analysis?.purposeRefs?.[0];
 const sourceRead=ref?await read(`source?path=${encodeURIComponent(ref.path)}&sha256=${ref.sha256}&start=${ref.start}&end=${ref.end}`):{value:null,error:'No current source reference'};
 const source:any=sourceRead.value,sourceOk=!!ref&&!!source&&source.sha256===ref.sha256&&typeof source.text==='string'&&source.text.length>0;
 emit('alpha-source-reference',sourceRead.error?'unknown':sourceOk?'passed':'behavior-failed',sourceOk?'Referenced current source readable':'Referenced source unavailable or mismatched',JSON.stringify({path:ref?.path??null,expected:ref?.sha256??null,received:source?.sha256??null,error:sourceRead.error}));
 const contextRead=round?await read(`verification-context?roundId=${encodeURIComponent(round.id)}`):{value:null,error:'Selected round missing'},context:any=contextRead.value;
 const binding=context?.binding,confirmation=state.closedLoop?.confirmation,contextOk=!!binding&&binding.roundId===round.id&&binding.goalHash===goal?.hash&&binding.sourceHash===state.mainline?.sourceHash&&binding.confirmationId===confirmation?.id&&binding.confirmationHash===confirmation?.hash&&binding.beforeSnapshotId===round.before.id&&binding.taskPurpose===round.purpose;
 emit('alpha-context-binding',contextRead.error?'unknown':contextOk?'passed':'behavior-failed',contextOk?'Verification context matches selected round':'Verification context binding differs',JSON.stringify({roundId:round?.id??null,sourceHash:binding?.sourceHash??null,confirmationId:binding?.confirmationId??null,error:contextRead.error}));
 const receipts=state.closedLoop?.receipts??[],conditionEntries=comparison?.criteria??[];
 const observedStatus=(statuses:string[])=>(['behavior-failed','missing-capability','environment-blocked'].find(x=>statuses.includes(x))??(statuses.length&&statuses.every(x=>x==='passed')?'passed':'unknown'));
 const receiptOk=!!comparison&&conditionEntries.length>0&&conditionEntries.every((c:any)=>{
  const current=confirmation?.scenarios?.find((s:any)=>s.id===c.scenarioId)?.criteria?.find((x:any)=>x.id===c.criterionId),criterionHash=current?hash(current):null;
  const statuses=(ids:string[],sourceHash:string,side:'before'|'after')=>ids.flatMap((receiptId:string)=>{const r=receipts.find((x:any)=>x.id===receiptId);if(!r||r.binding.goalHash!==goal?.hash||r.binding.sourceHash!==sourceHash||r.sourceAfterHash!==sourceHash||r.sourceChanged||side==='after'&&(r.binding.roundId!==round?.id||r.binding.roundBindingHash!==binding?.roundBindingHash||r.binding.beforeSnapshotId!==round?.before?.id||r.binding.taskPurpose!==round?.purpose||r.binding.confirmationId!==confirmation?.id||r.binding.confirmationHash!==confirmation?.hash)||side==='before'&&!c.before.confirmationIds.includes(r.binding.confirmationId))return ['invalid'];return r.checks.flatMap((check:any)=>check.assertions.filter((a:any)=>a.scenarioId===c.scenarioId&&a.criterionId===c.criterionId&&a.criterionHash===criterionHash).map((a:any)=>a.status));});
  const afterStatuses=statuses(c.after.receiptIds,round?.after?.sourceHash,'after'),beforeStatuses=statuses(c.before.receiptIds,round?.before?.sourceHash,'before');
  const afterValid=!afterStatuses.includes('invalid')&&afterStatuses.length>=c.after.receiptIds.length&&observedStatus(afterStatuses)===c.after.status;
  const beforeValid=!beforeStatuses.includes('invalid')&&beforeStatuses.length>=c.before.receiptIds.length&&observedStatus(beforeStatuses)===c.before.status;
  return !!current&&afterValid&&beforeValid;
 });
 const evidenceCount=conditionEntries.reduce((n:number,c:any)=>n+c.before.receiptIds.length+c.after.receiptIds.length,0);
 emit('alpha-receipt-bindings',!evidenceCount?'unknown':receiptOk?'passed':'behavior-failed',receiptOk&&evidenceCount?'Condition receipts match their source and goal':!evidenceCount?'No condition receipt to bind':'Condition receipt binding mismatch',JSON.stringify({roundId:round?.id??null,criterionCount:conditionEntries.length,receiptCount:evidenceCount}));
}
async function main(){
 if(args.includes('--probe-state')){const url=flag('url'),id=flag('project');if(!url||!id)throw new Error('--probe-state requires --url and --project');await probeState(url,id);return;}
 if(args.includes('--probe-mainline')){const url=flag('url'),id=flag('project');if(!url||!id)throw new Error('--probe-mainline requires --url and --project');await probeMainline(url,id,flag('round'));return;}
 if(args.includes('--help')){console.log('project-os-verify.ts --config FILE --project ID --round ID --checks ID,ID --output FILE [--url http://127.0.0.1:PORT]\nproject-os-verify.ts --probe-mainline --url http://127.0.0.1:PORT/ --project ID [--round ID]\nRuns only config.verificationChecks[project] argv. Output is exclusive immutable receipt; import through verification-import using a configured evidence-root reference. Probes only read loopback service state. No HTTP execution endpoint.');return;}
 const path=flag('config'),id=flag('project'),round=flag('round'),selected=flag('checks'),output=flag('output');if(!path||!id||!round||!selected||!output)throw new Error('config/project/round/checks/output required');
 const config=configSchema.parse(JSON.parse(readFileSync(path,'utf8'))),project=config.projects.find(p=>p.id===id);if(!project)throw new Error('Project not registered');
 let service:HumanGoalService|undefined,url=flag('url');const endpoint=join(config.dataDir,'server-endpoint.json');if(!url&&existsSync(endpoint))url=JSON.parse(readFileSync(endpoint,'utf8')).url;
 const controller=new AbortController(),abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
 try{let context:VerificationContext;
  if(url){const parsed=new URL(url);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('Only loopback server URL allowed');const response=await fetch(`${parsed.origin}/api/projects/${encodeURIComponent(id)}/verification-context?roundId=${encodeURIComponent(round)}`);if(!response.ok)throw new Error(await response.text());context=await response.json() as VerificationContext;}
  else {service=new HumanGoalService(config,undefined,{dispatchRoundAnalysis:false});context=service.verificationContext(id,round);}
  if(existsSync(output))throw new Error('Receipt output exists; retain original and choose a new explicit output');
  const receipt=await runVerification(config,project,context,selected.split(','),controller.signal),bytes=JSON.stringify(receipt,null,2);writeFileSync(output,bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({path:output,sha256:digest(bytes),receiptId:receipt.id,sourceChanged:receipt.sourceChanged,conditions:receipt.checks.flatMap(c=>c.assertions.map(a=>({scenarioId:a.scenarioId,criterionId:a.criterionId,status:a.status})))}));
 }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);await service?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:String(e),code:e.code??null}));process.exitCode=1;});
