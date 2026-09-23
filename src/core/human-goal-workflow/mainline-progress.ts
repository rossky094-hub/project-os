import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectRounds } from './rounds.js';
import { activeConfirmation } from './scenarios.js';
import { hash, safeId, text, type ScenarioSet, type Session, type View, WorkflowError } from './types.js';

export const mainlineIntentSchema=z.object({
 viewAttemptId:safeId,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),journeyId:safeId,
 stepIds:z.array(safeId).min(1).max(100),kind:z.enum(['direct-product','support-infrastructure']),
 reason:text,expectedVerification:text
}).strict();
export type MainlineIntent=z.infer<typeof mainlineIntentSchema>;
export interface MainlineAnnotation extends MainlineIntent {
 id:string;roundId:string;goalHash:string;author:string;createdAt:string;
 previousId:string|null;idempotencyKey:string;requestHash:string;
 interpretationMode?:'historical-intent';observedSourceHash?:string;expectedCurrentSourceHash?:string;
}
export interface MainlineAnnotationData { revision:number; annotations:MainlineAnnotation[] }
export const mainlineData=(s:Session):MainlineAnnotationData=>s.mainlineAnnotations??{revision:0,annotations:[]};
const annotationBase=mainlineIntentSchema.extend({
 expectedRevision:z.number().int().nonnegative(),idempotencyKey:safeId,roundId:safeId,
 goalHash:z.string().regex(/^[a-f0-9]{64}$/),previousId:safeId.nullable(),author:text
});
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const mainlineAnnotationSchema=z.union([
 annotationBase.strict(),
 annotationBase.extend({interpretationMode:z.literal('historical-intent'),observedSourceHash:sha,expectedCurrentSourceHash:sha}).strict()
]);

export function currentMainlineView(s:Session,sourceHash:string):View|null {
 const view=s.currentView===null?null:s.views[s.currentView];
 return view&&view.goal?.hash===s.goals.at(-1)?.hash&&view.source.hash===sourceHash&&view.analysis.workflow?view:null;
}
function referenceMainlineView(s:Session):View|null {
 const view=s.currentView===null?null:s.views[s.currentView];
 return view&&view.goal?.hash===s.goals.at(-1)?.hash&&view.analysis.workflow?view:null;
}
function savedReference(s:Session,goalHash:string,viewAttemptId:string,sourceHash:string):View|null {
 const matches=s.views.filter(v=>v.attemptId===viewAttemptId&&v.source.hash===sourceHash&&v.goal?.hash===goalHash&&v.analysis.workflow);
 return matches.length===1?matches[0]:null;
}

export function validateMainlineIntent(intent:MainlineIntent,view:View,sourceHash:string):void {
 if(intent.viewAttemptId!==view.attemptId||intent.sourceHash!==sourceHash)
  throw new WorkflowError('STALE_MAINLINE','产品主线分析或来源已变化，请重新核对',409);
 const journey=view.analysis.workflow?.journeys.find(j=>j.id===intent.journeyId);
 if(!journey||new Set(intent.stepIds).size!==intent.stepIds.length||intent.stepIds.some(id=>!journey.observed.steps.some(step=>step.id===id)))
  throw new WorkflowError('REFERENCE_UNRESOLVED','所选旅程或实际步骤不属于当前分析');
}

// This annotation is an append-only interpretation of one observed round. It
// does not change the native event, round binding, human goal or analysis input.
export function appendMainlineAnnotation(s:Session,raw:unknown,sourceHash:string):MainlineAnnotation {
 const req=mainlineAnnotationSchema.parse(raw),data=s.mainlineAnnotations??={revision:0,annotations:[]};
 const requestHash=hash(req),replay=data.annotations.find(a=>a.idempotencyKey===req.idempotencyKey);
 if(replay){if(replay.requestHash!==requestHash)throw new WorkflowError('IDEMPOTENCY_CONFLICT','同一请求键不能用于不同关联',409);return replay;}
 if(req.expectedRevision!==data.revision)throw new WorkflowError('STALE_BASE','主线关联已有新修订，请读取后核对',409);
 const goal=s.goals.at(-1),historical='interpretationMode' in req;
 const view=historical?referenceMainlineView(s):currentMainlineView(s,sourceHash);
 if(!goal||req.goalHash!==goal.hash||!view)throw new WorkflowError('STALE_MAINLINE','需要与当前目标相符的已保存产品主线分析',409);
 validateMainlineIntent(req,view,view.source.hash);
 const registration=s.rounds?.registrations.find(r=>r.binding.roundId===req.roundId);
 if(!registration||registration.binding.goalHash!==goal.hash)throw new WorkflowError('REFERENCE_UNRESOLVED','所选轮次不存在或属于旧目标');
 const round=projectRounds(s,undefined,sourceHash).rounds.find(r=>r.id===req.roundId);
 if(!round||!round.after||round.stale)
  throw new WorkflowError('STALE_MAINLINE','该轮次的来源或目标已过时，只能作为历史核查',409);
 if(historical){
  if(req.expectedCurrentSourceHash!==sourceHash||req.observedSourceHash!==round.after.sourceHash)
   throw new WorkflowError('STALE_MAINLINE','当前来源或轮次观察已变化，请重新核对关联',409);
 }else if(round.after.sourceHash!==sourceHash||round.sourceStale)
  throw new WorkflowError('STALE_MAINLINE','该轮次的来源或目标已过时，只能作为历史核查',409);
 const prior=[...data.annotations].reverse().find(a=>a.roundId===req.roundId);
 if((prior?.id??null)!==req.previousId)throw new WorkflowError('STALE_BASE','已有较新的轮次关联，请读取后核对',409);
 const annotation:MainlineAnnotation={...req,id:`mainline-${randomUUID()}`,createdAt:new Date().toISOString(),requestHash};
 data.annotations.push(annotation);data.revision++;
 return annotation;
}

type RoundProjection=ReturnType<typeof projectRounds>['rounds'][number];
type Step=NonNullable<View['analysis']['workflow']>['journeys'][number]['observed']['steps'][number];
type Criterion=ScenarioSet['scenarios'][number]['criteria'][number];
function matchingConditions(s:Session,round:RoundProjection,step:Step,journeyId:string,view:View,sourceHash:string){
 if(!round.proofEligible||step.state!=='source-supported')return [];
 const confirmation=activeConfirmation(s);
 if(!confirmation||confirmation.sourceHash!==sourceHash||confirmation.analysisAttemptId!==view.attemptId||confirmation.goalHash!==round.goalHash)return [];
 return round.conditionVerified.filter(c=>{
  const criteria=confirmation.scenarios.flatMap(scenario=>scenario.criteria.filter(criterion=>scenario.id===c.scenarioId&&criterion.id===c.criterionId));
  if(criteria.length!==1)return false;
  const criterion=criteria[0];
  if(c.mapping!=='mapped'||criterion.mapping!=='mapped'||!criterion.journeyIds.includes(journeyId)||!criterion.targetIds.some(id=>step.targetIds.includes(id))||!criterion.clauseIds.some(id=>step.clauseIds.includes(id))||!c.receiptIds.length)return false;
  return c.receiptIds.every(id=>{
   const receipt=s.verificationReceipts?.find(r=>r.id===id);
   return receipt?.binding.roundId===round.id&&receipt.binding.goalHash===round.goalHash&&receipt.binding.sourceHash===sourceHash&&receipt.sourceAfterHash===sourceHash&&!receipt.sourceChanged&&receipt.binding.confirmationId===confirmation.id&&receipt.binding.confirmationHash===confirmation.hash&&receipt.binding.criteria.some(bound=>bound.scenarioId===c.scenarioId&&bound.criterionId===c.criterionId&&bound.criterionHash===hash(criterion));
  });
 });
}
function touchedPaths(round:RoundProjection,step:Step,view:View):string[]{
 if(step.state!=='source-supported')return [];
 const targets=[...view.analysis.modules,...view.analysis.edges].filter(t=>step.targetIds.includes(t.id));
 const refs=[...step.refs,...targets.flatMap(t=>t.refs)];
 return [...new Set(round.deltas.filter(delta=>refs.some(ref=>ref.path===delta.path)).map(delta=>delta.path))];
}
function outcome(conditions:ReturnType<typeof matchingConditions>,touched:string[],status:string):string {
 if(conditions.some(c=>!['passed','unknown'].includes(c.result)))return 'failed-blocked';
 if(conditions.some(c=>c.result==='passed'))return 'verified-scoped';
 if(['failed','cancelled','agent-failed'].includes(status))return 'work-failed';
 if(touched.length)return 'changed-unverified';
 return status==='running'?'active-intent':'intent-only';
}
const stepMeaning=(step:Step)=>hash({title:step.title,purpose:step.purpose,actor:step.actor,responsibility:step.responsibility,
 inputs:step.inputs,outputs:step.outputs,state:step.state,targetIds:step.targetIds,clauseIds:step.clauseIds});
type ConditionResult='passed'|'environment-blocked'|'missing-capability'|'behavior-failed'|'unknown';
function beforeCondition(s:Session,round:RoundProjection,criterion:Criterion,scenarioId:string,journeyId:string,selected:Step[],rounds:RoundProjection[]){
 const empty={status:'unknown' as ConditionResult,receiptIds:[] as string[],confirmationIds:[] as string[],history:[] as {receiptId:string;checkId:string;status:ConditionResult;current:boolean}[]};
 const beforeHash=round.before.sourceHash,goal=s.goals.find(g=>g.hash===round.goalHash);
 if(!goal||round.before.partial||round.before.kind!=='captured'||round.after?.kind!=='captured')return {...empty,comparable:false,reason:'开发前后来源或目标绑定不完整'};
 // The captured starting snapshot is the only fixed before boundary. Later same-source
 // checkpoints may extend after evidence, but cannot turn a new receipt into prior proof.
 const cutoff=Date.parse(round.before.observedAt??'');
 if(!Number.isFinite(cutoff))return {...empty,comparable:false,reason:'开发前来源缺少可定位的起始时间'};
 const allowedRounds=new Set(rounds.slice(0,rounds.findIndex(r=>r.id===round.id)+1).map(r=>r.id));
 const records=(s.verificationReceipts??[]).filter(receipt=>{
  const b=receipt.binding,confirmation=s.scenarioSets?.find(c=>c.id===b.confirmationId&&c.hash===b.confirmationHash&&c.status==='confirmed');
  const registration=s.rounds?.registrations.find(r=>r.bindingHash===b.roundBindingHash);
  return b.sourceHash===beforeHash&&receipt.sourceAfterHash===beforeHash&&!receipt.sourceChanged&&b.goalHash===goal.hash&&b.goalVersion===goal.version&&Date.parse(receipt.endedAt)<cutoff&&
   (beforeHash!==round.after!.sourceHash||b.roundId!==round.id)&&
   allowedRounds.has(b.roundId)&&registration?.binding.roundId===b.roundId&&registration.binding.beforeSnapshotId===b.beforeSnapshotId&&
   confirmation?.goalHash===goal.hash&&confirmation.sourceHash===beforeHash&&
   confirmation.scenarios.some(sc=>sc.id===scenarioId&&sc.criteria.some(c=>c.id===criterion.id))&&
   s.views.some(v=>v.attemptId===confirmation.analysisAttemptId&&v.source.hash===beforeHash&&v.goal?.hash===goal.hash);
 });
 const relevant=records.filter(r=>r.checks.some(c=>c.assertions.some(a=>a.scenarioId===scenarioId&&a.criterionId===criterion.id)));
 if(!relevant.length)return {...empty,comparable:true,reason:'此前同一条件没有独立回执'};
 const criterionHash=hash(criterion);
 const incompatible=relevant.some(r=>{
  const confirmation=s.scenarioSets!.find(c=>c.id===r.binding.confirmationId)!,old=confirmation.scenarios.find(sc=>sc.id===scenarioId)!.criteria.find(c=>c.id===criterion.id)!;
  const priorView=s.views.find(v=>v.attemptId===confirmation.analysisAttemptId&&v.source.hash===beforeHash&&v.goal?.hash===goal.hash)!;
  const oldJourney=priorView.analysis.workflow?.journeys.find(j=>j.id===journeyId);
  return hash(old)!==criterionHash||!r.binding.criteria.some(c=>c.scenarioId===scenarioId&&c.criterionId===criterion.id&&c.criterionHash===criterionHash)||
   !oldJourney||selected.some(step=>{const previous=oldJourney.observed.steps.find(x=>x.id===step.id);return !previous||stepMeaning(previous)!==stepMeaning(step);});
 });
 if(incompatible)return {...empty,comparable:false,reason:'此前条件或步骤版本不同，须重新核对'};
 const assertions=relevant.flatMap(receipt=>receipt.checks.flatMap(check=>check.assertions.filter(a=>a.scenarioId===scenarioId&&a.criterionId===criterion.id&&a.criterionHash===criterionHash)
  .map(a=>({receiptId:receipt.id,checkId:check.id,status:a.status,startedAt:check.startedAt,endedAt:check.endedAt,identity:hash([check.id,check.configHash,a.assertionId,a.criterionHash])}))));
 const history=assertions.map(a=>({receiptId:a.receiptId,checkId:a.checkId,status:a.status,current:!assertions.some(b=>b.identity===a.identity&&Date.parse(b.startedAt)>=Date.parse(a.endedAt)&&Date.parse(b.startedAt)>Date.parse(a.startedAt))}));
 const current=history.filter(x=>x.current),negative=(['behavior-failed','missing-capability','environment-blocked'] as const).find(status=>current.some(x=>x.status===status));
 const status:ConditionResult=negative??(current.length&&current.every(x=>x.status==='passed')?'passed':'unknown');
 return {status,receiptIds:[...new Set(current.map(x=>x.receiptId))],confirmationIds:[...new Set(relevant.map(r=>r.binding.confirmationId))],history,comparable:true,reason:current.length?'此前同一目标、来源、条件与步骤的独立回执':'此前回执已被后续检查取代'};
}
function roundComparison(s:Session,round:RoundProjection,rounds:RoundProjection[],mappingState:'confirmed'|'stale'|'unknown',view:View|null,journey:NonNullable<View['analysis']['workflow']>['journeys'][number]|undefined,selected:Step[],conditions:{scenarioId:string;criterionId:string;result:string;receiptIds:string[]}[],sourceHash:string,nextVerification:string){
 const confirmation=activeConfirmation(s),sourceChanges=round.deltas.map(d=>({path:d.path,kind:d.kind,before:d.before,after:d.after}));
 const base={beforeSourceHash:round.before.sourceHash,afterSourceHash:round.after?.sourceHash??null,sourceChanges,goalHash:round.goalHash,
  goalVersion:s.goals.find(g=>g.hash===round.goalHash)?.version??null,confirmationId:confirmation?.goalHash===round.goalHash?confirmation.id:null,criteria:[] as {scenarioId:string;criterionId:string;text:string;before:ReturnType<typeof beforeCondition>;after:{status:ConditionResult;receiptIds:string[]};transition:string;reason:string}[],resolved:[] as string[],unverified:[] as string[],summary:'',nextReason:nextVerification};
 if(mappingState!=='confirmed'||!view||!journey||!round.after||!round.proofEligible||!confirmation||confirmation.sourceHash!==sourceHash||confirmation.analysisAttemptId!==view.attemptId)
  return {...base,state:mappingState==='unknown'?'unmapped':'incomparable',summary:'当前目标、来源、分析、关联或轮次证据未同时匹配；保存的意图与旧回执只供核对。'};
 const applicable=confirmation.scenarios.flatMap(scenario=>scenario.criteria.filter(criterion=>criterion.mapping==='mapped'&&criterion.journeyIds.includes(journey.id)&&selected.some(step=>step.state==='source-supported'&&criterion.targetIds.some(id=>step.targetIds.includes(id))&&criterion.clauseIds.some(id=>step.clauseIds.includes(id)))).map(criterion=>({scenarioId:scenario.id,criterion})));
 if(!applicable.length)return {...base,state:'incomparable',summary:'所选步骤尚无已确认且映射明确的条件；需要先核对验证条件。'};
 const criteria=applicable.map(({scenarioId,criterion})=>{
  const before=beforeCondition(s,round,criterion,scenarioId,journey.id,selected,rounds),matched=conditions.find(c=>c.scenarioId===scenarioId&&c.criterionId===criterion.id);
  const afterStatus:ConditionResult=matched&&['passed','environment-blocked','missing-capability','behavior-failed','unknown'].includes(matched.result)?matched.result as ConditionResult:'unknown';
  const after={status:afterStatus,receiptIds:matched?.receiptIds??[]};
  const transition=!before.comparable?'incomparable':!before.receiptIds.length?after.status==='passed'?'new-evidence':'unverified':
   before.status!=='passed'&&before.status!=='unknown'&&after.status==='passed'?'resolved':before.status==='passed'&&after.status!=='passed'?'regressed':
   after.status==='unknown'?'unverified':before.status===after.status?'unchanged':'changed';
  return {scenarioId,criterionId:criterion.id,text:criterion.text,before,after,transition,reason:before.reason};
 });
 const resolved=criteria.filter(c=>c.transition==='resolved').map(c=>c.text),unverified=criteria.filter(c=>c.after.status!=='passed'||c.transition==='incomparable').map(c=>c.text);
 const state=criteria.some(c=>c.transition==='incomparable')?'incomparable':criteria.some(c=>!c.before.receiptIds.length)?'unknown-before':'comparable';
 const summary=state==='incomparable'?'条件、步骤或证据版本不同；前后结果须重新核对。':
  resolved.length?`此前失败或受阻的 ${resolved.length} 项条件，本轮有匹配的独立通过回执；仍需核对完整目标。`:
  state==='unknown-before'?'此前没有可比的独立条件回执；本轮结果只能说明当前限定条件，不能推断改善幅度。':
  '前后条件回执已对照；通过仅限映射条件，仍需核对整体目标。';
 return {...base,state,criteria,resolved,unverified,summary,nextReason:unverified.length?`先核对或验证：${unverified[0]}`:nextVerification};
}
export function projectMainlineProgress(s:Session,sourceHash:string,roundProjection=projectRounds(s,undefined,sourceHash)){
 const view=currentMainlineView(s,sourceHash),referenceView=referenceMainlineView(s),goal=s.goals.at(-1),data=mainlineData(s),workflow=referenceView?.analysis.workflow;
 const turns=s.agentActivity?.events.filter(e=>e.kind==='turn-start'&&e.roundId)??[];
 const rounds=roundProjection.rounds.map(round=>{
  const lastAnnotation=[...data.annotations].reverse().find(a=>a.roundId===round.id);
  const start=turns.find(e=>e.roundId===round.id),connection=s.agentActivity?.connections.find(c=>c.id===start?.connectionId);
  const declared=lastAnnotation??connection?.mainlineIntent;
  const mappingOrigin=lastAnnotation?'annotation':connection?.mainlineIntent?'connection':'none';
  const boundGoal=lastAnnotation?.goalHash??connection?.goalHash??round.goalHash;
  const intentView=declared?savedReference(s,boundGoal,declared.viewAttemptId,declared.sourceHash):null;
  const intentJourney=intentView?.analysis.workflow?.journeys.find(j=>j.id===declared?.journeyId);
  const validIntentSteps=!!intentJourney&&!!declared&&new Set(declared.stepIds).size===declared.stepIds.length&&declared.stepIds.every(id=>intentJourney.observed.steps.some(step=>step.id===id));
  const intentRelation=!declared?'unknown':!validIntentSteps?'unresolved':boundGoal!==goal?.hash?'old-goal':intentView===referenceView?'reference-visible':'pending-remap';
  const intentSteps=validIntentSteps?intentJourney!.observed.steps.filter(step=>declared!.stepIds.includes(step.id)).map(step=>({id:step.id,title:step.title,purpose:step.purpose})):[];
  let mappingState:'confirmed'|'stale'|'unknown'='unknown';
  if(declared){
   const valid=lastAnnotation?.interpretationMode!=='historical-intent'&&!!view&&!!goal&&boundGoal===goal.hash&&round.goalHash===goal.hash&&round.after?.sourceHash===sourceHash&&!round.sourceStale&&!round.stale&&
    intentView===view&&validIntentSteps;
   mappingState=valid?'confirmed':'stale';
  }
  const journey=view?.analysis.workflow?.journeys.find(j=>j.id===declared?.journeyId);
  const steps=mappingState==='confirmed'&&view&&journey?journey.observed.steps.filter(step=>declared!.stepIds.includes(step.id)).map(step=>{
   const touched=touchedPaths(round,step,view),conditions=matchingConditions(s,round,step,journey.id,view,sourceHash);
   return {id:step.id,title:step.title,touchedPaths:touched,conditions:conditions.map(c=>({scenarioId:c.scenarioId,criterionId:c.criterionId,text:c.text,result:c.result,recovered:c.recovered,receiptIds:c.receiptIds})),outcome:outcome(conditions,touched,round.status)};
  }):[];
  const candidates=!declared&&view&&round.goalHash===goal?.hash&&round.after?.sourceHash===sourceHash?view.analysis.workflow!.journeys.flatMap(j=>j.observed.steps.flatMap(step=>{
   const paths=touchedPaths(round,step,view);return paths.length?[{journeyId:j.id,journeyTitle:j.title,stepId:step.id,stepTitle:step.title,paths}]:[];
  })):[];
  const confirmation=activeConfirmation(s),selected=journey?.observed.steps.filter(step=>declared?.stepIds.includes(step.id))??[];
  const applicable=mappingState==='confirmed'&&view&&confirmation?.sourceHash===sourceHash&&confirmation.analysisAttemptId===view.attemptId?
   confirmation.scenarios.flatMap(scenario=>scenario.criteria.filter(criterion=>criterion.mapping==='mapped'&&criterion.journeyIds.includes(journey!.id)&&selected.some(step=>step.state==='source-supported'&&criterion.targetIds.some(id=>step.targetIds.includes(id))&&criterion.clauseIds.some(id=>step.clauseIds.includes(id))))):[];
  const matched=steps.flatMap(step=>step.conditions),unresolved=applicable.filter(c=>!matched.some(result=>result.criterionId===c.id&&result.result==='passed'));
  const scopedRemaining=mappingState==='confirmed'&&round.proofEligible&&confirmation?applicable.length?
   `所选步骤确认条件 ${applicable.length-unresolved.length}/${applicable.length} 限定通过；${unresolved.map(c=>c.text).join('；')||'整体旅程仍须核对'}`:'所选步骤尚无明确映射的确认条件；需核对旅程与条件映射。':round.remaining;
  const scopedNext=mappingState==='confirmed'&&round.proofEligible&&confirmation?unresolved.length?`验证条件：${unresolved[0].text}`:applicable.length?'复核所选步骤的完整使用结果和整体目标':'核对所选步骤的确认条件映射':round.next;
  const changedPaths=round.deltas.map(d=>d.path),failed=steps.some(step=>step.outcome==='failed-blocked'),verified=steps.some(step=>step.outcome==='verified-scoped');
  const status=mappingState==='stale'?'stale':mappingState==='unknown'?'unmapped':failed?'failed-blocked':verified&&steps.every(step=>step.outcome==='verified-scoped')?'verified-scoped':verified?'partial-verified':steps.some(step=>step.outcome==='work-failed')?'work-failed':steps.some(step=>step.outcome==='changed-unverified')?'changed-unverified':round.status==='running'?'active-intent':'intent-only';
  const bound=s.goals.find(g=>g.hash===round.goalHash),goalClauses=round.clauseIds.map(id=>bound?.clauses.find(c=>c.id===id)?.text).filter((x):x is string=>!!x);
  const remainingGaps=mappingState==='confirmed'&&round.viewAttemptId===view?.attemptId?view.gaps.filter(g=>round.gapIds.includes(g.id)&&g.lifecycle==='open'&&selected.some(step=>g.targetIds.some(id=>step.targetIds.includes(id))&&g.clauseIds.some(id=>step.clauseIds.includes(id)))).map(g=>g.expected):[];
  const comparison=roundComparison(s,round,roundProjection.rounds,mappingState,view,journey,selected,steps.flatMap(step=>step.conditions),sourceHash,scopedNext);
  return {roundId:round.id,turnId:start?.turnId??null,connectionId:start?.connectionId??null,taskId:round.taskId,purpose:round.purpose,goalHash:round.goalHash,
   mapping:{state:mappingState,intentRelation,origin:mappingOrigin,annotationId:lastAnnotation?.id??null,journeyId:declared?.journeyId??null,journeyTitle:intentJourney?.title??null,stepIds:declared?.stepIds??[],kind:declared?.kind??null,reason:declared?.reason??null,expectedVerification:declared?.expectedVerification??null,viewAttemptId:declared?.viewAttemptId??null,sourceHash:declared?.sourceHash??null,referenceGoalVersion:intentView?.goal?.version??null,observedSourceHash:lastAnnotation?.observedSourceHash??round.after?.sourceHash??null},
   status,executionStatus:round.status,goalClauses,steps,intentSteps,candidates,changedPaths,comparison,reported:round.reported,remaining:scopedRemaining,remainingGaps,nextVerification:scopedNext,
   sourceCoverage:round.sourceCoverage,proofEligible:round.proofEligible};
 });
 const journeys=(workflow?.journeys??[]).map(j=>{
  const related=rounds.filter(r=>r.mapping.intentRelation==='reference-visible'&&r.mapping.journeyId===j.id);
  return {id:j.id,title:j.title,steps:j.observed.steps.map(step=>({id:step.id,title:step.title,work:related.filter(r=>r.intentSteps.some(s=>s.id===step.id)).map(r=>({roundId:r.roundId,turnId:r.turnId,status:r.steps.find(s=>s.id===step.id)?.outcome??'stale'}))})),
   feed:related.map(r=>({roundId:r.roundId,turnId:r.turnId,purpose:r.purpose,status:r.status,kind:r.mapping.kind,reason:r.mapping.reason,stepTitles:r.intentSteps.map(s=>s.title),remaining:r.remaining,comparison:r.comparison,nextVerification:r.mapping.state==='confirmed'?r.nextVerification:r.mapping.expectedVerification??r.nextVerification})).slice(-5).reverse(),
   nextVerification:related.at(-1)?.nextVerification??'先核对该旅程的开发目的与条件验证。'};
 });
 return {revision:data.revision,sourceHash,goalHash:goal?.hash??null,viewAttemptId:view?.attemptId??null,status:view?'current':referenceView?'stale-source':'unknown-current-view',referenceViewAttemptId:referenceView?.attemptId??null,referenceSourceHash:referenceView?.source.hash??null,referenceGoalHash:referenceView?.goal?.hash??null,
  annotations:data.annotations.map(a=>({id:a.id,roundId:a.roundId,previousId:a.previousId,createdAt:a.createdAt,author:a.author,journeyId:a.journeyId,stepIds:a.stepIds,kind:a.kind,reason:a.reason,expectedVerification:a.expectedVerification,goalHash:a.goalHash,sourceHash:a.sourceHash,viewAttemptId:a.viewAttemptId,interpretationMode:a.interpretationMode??null,observedSourceHash:a.observedSourceHash??null,expectedCurrentSourceHash:a.expectedCurrentSourceHash??null})),rounds,journeys};
}
