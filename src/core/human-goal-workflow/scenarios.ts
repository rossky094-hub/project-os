import { hash, WorkflowError, type Analysis, type Goal, type Scenario, type ScenarioSet, type Session } from './types.js';
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
 const confirmed=activeConfirmation(s),goal=s.goals.at(-1),view=s.currentView===null?null:s.views[s.currentView];
 const receipts=s.verificationReceipts??[];
 const criteria=(confirmed?.scenarios??[]).flatMap(scenario=>scenario.criteria.map(criterion=>{
  const relevant=receipts.filter(r=>r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged&&r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed!.hash);
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
 const status=!confirmed?'needs-confirmation':!critical.length||uncovered.length||critical.some(c=>c.status!=='passed'||c.mapping!=='mapped')?'incomplete':'verified';
 return {sourceHash,status,gapProgress,confirmation:confirmed,criteria,uncoveredClauseIds:uncovered,commonBlockers,diagnosisStale:stale,priorityReason:commonBlockers.length?'多个确认场景共用同一未验证实现，先核对共同阻碍；这不证明架构失败。':'先核对关键场景的未验证或失败条件，再考虑局部优化。',nextAction:!confirmed?'核对并确认模型提出的场景与验收条件':stale?'按当前目标、场景、来源和证据重新分析主线':relevantRecommendation?recommendation!.action:status==='verified'?'复核限定范围证据与剩余未知，再决定下一轮目标':'请模型先核对关键旅程与共同阻碍，补充对应条件的实际验证',recommendation:relevantRecommendation?recommendation:null,alternatives:diagnosis?.alternatives??[],limitations:['限定确认场景和登记来源；不是整体验收或人类接受','静态调用关系不能产生运行调用图'],receipts:receipts.map(r=>({...r,current:r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed?.hash&&r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged})),runtimeCalls:receipts.filter(r=>r.binding.sourceHash===sourceHash&&r.sourceAfterHash===sourceHash&&!r.sourceChanged&&r.binding.goalHash===goal?.hash&&r.binding.confirmationHash===confirmed?.hash).flatMap(r=>r.checks.flatMap(c=>c.traces.map(t=>({...t,receiptId:r.id,roundId:r.binding.roundId,observedAt:c.endedAt,checkId:c.id,exitCode:c.exitCode,executionError:c.executionError,assertionStatuses:c.assertions.map(a=>a.status),edgePassed:criteria.some(a=>a.targetIds.includes(t.edgeId)&&a.mapping==='mapped'&&a.status==='passed'&&a.evidence.some(e=>e.current&&e.receiptId===r.id&&e.checkId===c.id))}))))};
}
