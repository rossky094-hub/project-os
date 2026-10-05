import { hash, WorkflowError, type Analysis, type Goal, type Scenario, type ScenarioSet, type Session, type View } from './types.js';
type MappingReferences={clauseIds:string[];targetIds:string[];journeyIds:string[]};
// Compare functional contracts and source bindings, not IDs or a model's claim
// of equivalence. New evidence/presentation does not redefine an accepted goal.
function mappingBasis(view:View,references:MappingReferences):string|null {
 const select=<T extends {id:string}>(items:T[],ids:string[]):T[]|null=>{
  const result:T[]=[];for(const id of [...new Set(ids)].sort()){const matches=items.filter(x=>x.id===id);if(matches.length!==1)return null;result.push(matches[0]);}return result;
 };
 const clauses=select(view.goal?.clauses??[],references.clauseIds),targets=select([...view.analysis.modules,...view.analysis.edges],references.targetIds),journeys=select([...(view.analysis.workflow?.journeys??[]),...(view.analysis.diagnosis?.journeys??[])],references.journeyIds);
 const alignments=view.analysis.alignments.filter(x=>x.clauseIds.some(id=>references.clauseIds.includes(id))),conflicts=view.analysis.conflicts.filter(x=>references.targetIds.includes(x.targetId)||x.clauseIds.some(id=>references.clauseIds.includes(id)));
 if(!clauses||!targets||!journeys)return null;
 const contracts=targets.map(x=>'from' in x?{id:x.id,from:x.from,to:x.to,label:x.label,expected:x.expected,kind:x.kind,refs:x.refs}:{id:x.id,kind:x.kind,responsibility:x.responsibility,inputs:x.inputs,outputs:x.outputs,refs:x.refs,supersedes:x.supersedes});
 const flows=journeys.map(j=>'observed' in j?{id:j.id,purpose:j.purpose,clauseIds:j.clauseIds,observed:{
  steps:j.observed.steps.map(({id,purpose,actor,responsibility,inputs,outputs,targetIds,clauseIds,refs})=>({id,purpose,actor,responsibility,inputs,outputs,targetIds,clauseIds,refs})),
  links:j.observed.links.map(({id,from,to,kind,condition,meaning,targetIds,clauseIds,refs})=>({id,from,to,kind,condition,meaning,targetIds,clauseIds,refs}))
 }}:{id:j.id,clauseIds:j.clauseIds,targetIds:j.targetIds,expected:j.expected,refs:j.refs});
 const mappings=alignments.map(({id,clauseIds,targetIds,refs})=>({id,clauseIds,targetIds,refs}));
 const conflictingContracts=conflicts.map(({targetId,clauseIds,parentText,moduleText})=>({targetId,clauseIds,parentText,moduleText}));
 return hash({clauses,contracts,flows,mappings,conflicts:conflictingContracts});
}
export function mappingContinuity(s:Session,from:View|null|undefined,to:View|null|undefined,references:MappingReferences):'same-analysis'|'unchanged-mapping'|'needs-review' {
 if(!from||!to||from.source.hash!==to.source.hash||from.goal?.hash!==to.goal?.hash||!to.goal||from.source.partial||to.source.partial)return 'needs-review';
 if(from.attemptId===to.attemptId)return 'same-analysis';
 const basis=mappingBasis(from,references);if(!basis)return 'needs-review';
 let current=to;const visited=new Set<string>();
 while(current.attemptId!==from.attemptId){
  if(visited.has(current.attemptId)||mappingBasis(current,references)!==basis)return 'needs-review';visited.add(current.attemptId);
  const links=(s.analysisContinuations??[]).filter(x=>x.toAttemptId===current.attemptId&&x.sourceHash===to.source.hash&&x.goalHash===to.goal!.hash&&x.toAnalysisHash===hash(current.analysis));
  if(links.length!==1)return 'needs-review';
  const previous=s.views.filter(v=>v.attemptId===links[0].fromAttemptId&&v.source.hash===to.source.hash&&v.goal?.hash===to.goal!.hash&&hash(v.analysis)===links[0].fromAnalysisHash);
  if(previous.length!==1)return 'needs-review';current=previous[0];
 }
 return 'unchanged-mapping';
}
export function confirmationMapping(s:Session,confirmation:ScenarioSet|null,view:View|null|undefined,sourceHash:string){
 const from=s.views.find(v=>v.attemptId===confirmation?.analysisAttemptId);
 const items=confirmation?.scenarios.flatMap(scenario=>[scenario,...scenario.criteria])??[];
 const status=!confirmation||confirmation.sourceHash!==sourceHash||confirmation.goalHash!==s.goals.at(-1)?.hash||view?.source.hash!==sourceHash?'needs-review':mappingContinuity(s,from,view,{clauseIds:items.flatMap(x=>x.clauseIds),targetIds:items.flatMap(x=>x.targetIds),journeyIds:items.flatMap(x=>x.journeyIds)});
 return {status,applicable:status!=='needs-review',fromAttemptId:confirmation?.analysisAttemptId??null,toAttemptId:view?.attemptId??null,reason:status==='same-analysis'?'确认对应当前分析':status==='unchanged-mapping'?'目标、来源及相关映射依据未变；原确认与回执保留，已接续到新分析':'目标、来源或相关映射依据变化，或缺少真实分析接续记录；请重新核对场景与条件'};
}
// Reusing IDs does not establish that old mappings apply to a changed meaning.
// Keep the references as candidates; a subsequent explicit review can remap them.
export function reviewChangedMeanings(previous:Scenario[],requested:Scenario[]):Scenario[]{
 const scenarios=structuredClone(requested);
 const invalidate=(item:Scenario|Scenario['criteria'][number])=>{item.mapping='unknown';item.uncertainty='人工修改了含义；原关联仅为候选，需要重新核对目标、旅程与实现。';};
 for(const scenario of scenarios){
  const before=previous.find(s=>s.id===scenario.id);if(!before)continue;
  const changed=(['title','given','when','then'] as const).some(k=>scenario[k]!==before[k]);
  if(changed)invalidate(scenario);
  for(const criterion of scenario.criteria){
   const old=before.criteria.find(c=>c.id===criterion.id);
   if(changed||old&&(criterion.text!==old.text||criterion.observable!==old.observable))invalidate(criterion);
  }
 }
 return scenarios;
}
export function validateScenarios(scenarios:Scenario[],analysis:Analysis,goal:Goal|null){
 const seen=new Set<string>(),clauses=new Set(goal?.clauses.map(c=>c.id)??[]),targets=new Set([...analysis.modules,...analysis.edges].map(x=>x.id)),journeys=new Set([...(analysis.workflow?.journeys??[]),...(analysis.diagnosis?.journeys??[])].map(x=>x.id));
 const unique=(id:string)=>{if(seen.has(id))throw new WorkflowError('REFERENCE_UNRESOLVED','场景或条件 ID 重复');seen.add(id);};
 for(const s of scenarios){unique(s.id);for(const m of [s,...s.criteria]){
  if(m!==s)unique(m.id);
  if(m.clauseIds.some(id=>!clauses.has(id))||m.targetIds.some(id=>!targets.has(id))||m.journeyIds.some(id=>!journeys.has(id)))throw new WorkflowError('REFERENCE_UNRESOLVED','场景映射引用未知条款、旅程或实现');
  if(m.mapping==='mapped'&&(!m.clauseIds.length||!m.targetIds.length||!m.journeyIds.length))throw new WorkflowError('REFERENCE_UNRESOLVED','缺失映射须显式标为 unknown');
 }}
 if(!goal&&scenarios.length)throw new WorkflowError('GOAL_REQUIRED','无目标不能分解场景');
}
export function activeConfirmation(s:Session):ScenarioSet|null {
 const latest=[...(s.scenarioSets??[])].reverse().find(x=>x.goalHash===s.goals.at(-1)?.hash&&x.status!=='proposed');
 return latest?.status==='confirmed'?latest:null;
}
export function projectClosedLoop(s:Session,sourceHash:string,diagnosisCurrent=true){
 const goalReviews=projectGoalReviews(s,sourceHash);
 const confirmed=activeConfirmation(s),goal=s.goals.at(-1),view=s.currentView===null?null:s.views[s.currentView];
 const mapping=confirmationMapping(s,confirmed,view,sourceHash);
 const receipts=s.verificationReceipts??[];
 const criteria=(confirmed?.scenarios??[]).flatMap(scenario=>scenario.criteria.map(criterion=>{
  const relevant=receipts.filter(r=>mapping.applicable&&r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged&&r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed!.hash);
  const assertions=relevant.flatMap(receipt=>receipt.checks.flatMap(check=>check.assertions.filter(a=>a.scenarioId===scenario.id&&a.criterionId===criterion.id&&a.criterionHash===hash(criterion)).map(a=>({...a,receiptId:receipt.id,roundId:receipt.binding.roundId,checkId:check.id,configHash:check.configHash,startedAt:check.startedAt,at:check.endedAt,identity:hash([check.id,check.configHash,a.assertionId,a.criterionHash])}))));
  // Only a non-overlapping later execution of the identical check can supersede it.
  // Import order has no authority; concurrent or independent checks remain evidence.
  const evidence=assertions.map(a=>({...a,current:!assertions.some(b=>b.identity===a.identity&&Date.parse(b.startedAt)>=Date.parse(a.at)&&Date.parse(b.startedAt)>Date.parse(a.startedAt))}));
  const current=evidence.filter(a=>a.current),negative=(['behavior-failed','missing-capability','environment-blocked'] as const).find(status=>current.some(a=>a.status===status));
  const status=negative??(current.length&&current.every(a=>a.status==='passed')?'passed':'unknown');
  const recovered=status==='passed'&&evidence.some(a=>!a.current&&['behavior-failed','missing-capability','environment-blocked'].includes(a.status));
  return {scenarioId:scenario.id,scenarioTitle:scenario.title,critical:scenario.critical,criterionId:criterion.id,text:criterion.text,observable:criterion.observable,status,recovered,mixed:new Set(current.map(a=>a.status)).size>1,mapping:criterion.mapping,clauseIds:criterion.clauseIds,targetIds:criterion.targetIds,journeyIds:criterion.journeyIds,evidence};
 }));
 const critical=criteria.filter(c=>c.critical==='critical'),uncovered=(goal?.clauses??[]).filter(c=>['core','hard-constraint'].includes(c.importance)&&!critical.some(x=>x.clauseIds.includes(c.id))).map(c=>c.id);
 const blockers=criteria.filter(c=>c.status!=='passed'),commonBlockers=[...new Set(blockers.flatMap(c=>c.targetIds))].map(targetId=>({targetId,scenarioIds:[...new Set(blockers.filter(c=>c.targetIds.includes(targetId)).map(c=>c.scenarioId))]})).filter(b=>b.scenarioIds.length>1);
 const diagnosis=view?.analysis.diagnosis,stale=!diagnosisCurrent||view?.source.hash!==sourceHash||view?.goal?.hash!==goal?.hash;
 const recommendation=diagnosis&&!stale?diagnosis.recommendation:null;
 const relevantRecommendation=!!recommendation&&(!commonBlockers.length||commonBlockers.some(b=>recommendation.targetIds.includes(b.targetId)))&&(!critical.some(c=>c.status!=='passed')||critical.some(c=>c.status!=='passed'&&(c.clauseIds.some(id=>recommendation.clauseIds.includes(id))||c.journeyIds.some(id=>recommendation.journeyIds.includes(id)))));
 const gapProgress=(view?.gaps??[]).map(g=>{const matched=criteria.filter(c=>g.clauseIds.some(id=>c.clauseIds.includes(id))&&g.targetIds.some(id=>c.targetIds.includes(id)));return {gapId:g.id,reported:g.lifecycle,verified:matched.length>0&&g.clauseIds.every(id=>matched.some(c=>c.clauseIds.includes(id)))&&g.targetIds.every(id=>g.clauseIds.every(clause=>matched.some(c=>c.targetIds.includes(id)&&c.clauseIds.includes(clause))))&&matched.every(c=>c.status==='passed'&&c.mapping==='mapped'),criterionIds:matched.map(c=>c.criterionId)};});
 const status=!confirmed?'needs-confirmation':!mapping.applicable||!critical.length||uncovered.length||critical.some(c=>c.status!=='passed'||c.mapping!=='mapped')?'incomplete':'verified';
 const priorityReason=goalReviews.priority?goalReviews.reason:commonBlockers.length?'多个确认场景共用同一未验证实现，先核对共同阻碍；这不证明架构失败。':'先核对关键场景的未验证或失败条件，再考虑局部优化。';
 // This is the current decision, not an authored round note. Its qualification
 // comes from the live goal/source/material and condition mapping on every read.
 // In particular, saved feedback/evidence withdraws the old recommendation before
 // another model returns; an unchanged source hash alone cannot keep it current.
 const nextActionDetails=!goal?{kind:'goal-required',text:'填写你希望程序完成的目标，再核对代码理解',reason:'没有人类目标，不能判断代码是否在推进你需要的结果。',nextCheck:'目标原话已保存，并能与代码理解分别查看。'}:
  goalReviews.priority?{kind:'goal-counterexample',text:`先核对目标不符的具体反例：${goalReviews.priority.originalText}；下一观察：${goalReviews.priority.nextObservation}`,reason:goalReviews.reason,nextCheck:goalReviews.priority.nextObservation!}:
  stale?{kind:'analysis-required',text:'按当前目标、场景、来源和证据重新分析主线',reason:'目标、代码或反馈与证据已更新；上版建议尚未消费这些变化，旧说明中的动作仅保留为记录。',nextCheck:'新分析对应当前目标和来源，并解释新反馈或检查如何改变差距与下一行动。'}:
  !confirmed?{kind:'scenario-review',text:'核对并确认模型提出的场景与验收条件',reason:'先明确要完成的用户结果及观察方法，不能用已有代码或开发报告代替。',nextCheck:'关键场景的前提、动作、结果和可观察条件符合你的目标；缺失的映射明确保留未知。'}:
  !mapping.applicable?{kind:'mapping-review',text:mapping.reason,reason:'旧条件与当前目标、来源或功能含义不能直接对应，旧通过不能沿用。',nextCheck:'重新核对场景与实现关联；保留原条件、原回执及适用范围。'}:
  relevantRecommendation?{kind:'diagnosis',text:recommendation!.action,reason:recommendation!.reason,nextCheck:recommendation!.verificationJourney}:
  status==='verified'?{kind:'scope-review',text:'复核限定范围证据与剩余未知，再决定下一轮目标',reason:'已通过的是当前确认的限定条件；不能把它扩大为全部业务目标已完成。',nextCheck:'区分已经观察到的用户结果与未覆盖结果，再选择真正影响目标的下一项。'}:
  {kind:'verification-required',text:'请模型先核对关键旅程与共同阻碍，补充对应条件的实际验证',reason:priorityReason,nextCheck:critical.filter(c=>c.status!=='passed'||c.mapping!=='mapped').map(c=>`${c.text}：${c.observable}`).join('；')||'补齐重要目标对应的关键场景与可观察条件。'};
 return {sourceHash,status,gapProgress,confirmation:confirmed,confirmationMapping:mapping,criteria,uncoveredClauseIds:uncovered,commonBlockers,diagnosisStale:stale,priorityReason,goalReviews,nextAction:nextActionDetails.text,nextActionDetails:{...nextActionDetails,goalHash:goal?.hash??null,sourceHash,analysisAttemptId:view?.attemptId??null,confirmationId:confirmed?.id??null,diagnosisStale:stale},recommendation:relevantRecommendation?recommendation:null,alternatives:diagnosis?.alternatives??[],limitations:['限定确认场景和登记来源；不是整体验收或人类接受','静态调用关系不能产生运行调用图'],receipts:receipts.map(r=>({...r,current:mapping.applicable&&r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed?.hash&&r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged})),runtimeCalls:receipts.filter(r=>mapping.applicable&&r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged&&r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed?.hash).flatMap(r=>r.checks.flatMap(c=>c.traces.map(t=>({...t,receiptId:r.id,roundId:r.binding.roundId,observedAt:c.endedAt,checkId:c.id,exitCode:c.exitCode,executionError:c.executionError,assertionStatuses:c.assertions.map(a=>a.status),edgePassed:criteria.some(a=>a.targetIds.includes(t.edgeId)&&a.mapping==='mapped'&&a.status==='passed'&&a.evidence.some(e=>e.current&&e.receiptId===r.id&&e.checkId===c.id))}))))};
}

// Reader reports are durable feedback, never execution evidence or product acceptance.
export function projectGoalReviews(s:Session,sourceHash:string){
 const goal=s.goals.at(-1),view=s.currentView===null?null:s.views[s.currentView];
 const reports=s.feedback.filter(f=>f.goalReview&&!s.feedback.some(next=>next.supersedes===f.id));
 const clauses=(goal?.clauses??[]).map(clause=>{
  const latest=[...reports].reverse().find(f=>f.goalReview!.clauseId===clause.id&&f.goalReview!.goalHash===goal!.hash);
  const review=latest?.goalReview;
  const from=review?s.views.find(v=>v.attemptId===review.analysisAttemptId):null;
  const references={clauseIds:[clause.id],targetIds:from?.analysis.alignments.filter(a=>a.clauseIds.includes(clause.id)).flatMap(a=>a.targetIds)??[],journeyIds:from?.analysis.workflow?.journeys.filter(j=>j.clauseIds.includes(clause.id)||j.observed.steps.some(step=>step.clauseIds.includes(clause.id))).map(j=>j.id)??[]};
  const continuity=review?mappingContinuity(s,from,view,references):'needs-review';
  const applicable=!!review&&review.sourceHash===sourceHash&&view?.source.hash===sourceHash&&view.goal?.hash===goal!.hash&&continuity!=='needs-review';
  return {clauseId:clause.id,importance:clause.importance,feedbackId:latest?.id??null,decision:applicable?review!.decision:'unknown',status:!review?'unreviewed':applicable?'current':'stale',continuity,author:latest?.author??null,provenance:latest?.provenance??null,originalText:latest?.originalText??null,nextObservation:review?.nextObservation??null,createdAt:latest?.createdAt??null};
 });
 const priority=clauses.find(c=>c.status==='current'&&c.decision==='mismatch'&&['core','hard-constraint'].includes(c.importance))??clauses.find(c=>c.status==='current'&&c.decision==='mismatch');
 return {clauses,priority,historyCount:s.feedback.filter(f=>f.goalReview).length,acceptance:false,reason:priority?'已记录目标不符，应先核对反例及影响范围，再决定修局部还是调整主线；这是核对者报告，不是已验证根因。':'逐项目标意见只表达核对者判断；没有意见、旧版本或不能判断均保持未知，不由技术通过代替。'};
}
