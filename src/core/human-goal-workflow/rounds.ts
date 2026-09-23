import { projectClosedLoop } from './scenarios.js';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { discoverSource, contained, safePath } from './source.js';
import { hash, digest, safeId, text, WorkflowError, type Project, type Session, type View } from './types.js';
import type { SessionStore } from './store.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const now = () => new Date().toISOString();
export const recordRef = z.object({rootIndex:z.number().int().nonnegative(),path:text,sha256:sha}).strict();
export const snapshotRequestSchema=z.object({import:recordRef.optional()}).strict();
export const registrationRequestSchema=z.object({registrationId:safeId}).strict();
export const roundPolicySchema = z.object({window:z.number().int().min(2).max(30).default(3),noProofThreshold:z.number().int().min(2).max(30).default(3),addedBytesThreshold:z.number().int().nonnegative().default(20000)}).strict();
export interface RoundSnapshot { id:string; sourceHash:string; inventory:{path:string;sha256:string;bytes:number|null}[]; observedAt:string|null; importedAt:string; kind:'captured'|'historical-import'; evidenceHash:string|null; partial:boolean; coverage:string[] }
export const enrollmentSchema = z.object({id:safeId,projectId:safeId,repoRoot:text,worktreeRoot:text,branch:text,tool:z.enum(['codex-exec','codex-native']),toolVersion:text,taskId:safeId,roundId:safeId,attemptId:safeId,producerId:safeId,mode:z.enum(['live','historical-replay']),goalHash:sha,feedbackIds:z.array(safeId).max(100),purpose:text,clauseIds:z.array(safeId).min(1).max(100),journeyIds:z.array(safeId).max(100),selectedActionIds:z.array(safeId).max(100),acceptedPlan:z.object({originalText:text,author:text,provenance:text}).strict().nullable(),beforeSnapshotId:safeId,stream:z.object({rootIndex:z.number().int().nonnegative(),path:text}).strict(),deferredBenefit:z.object({goalHash:sha,blocker:text,payoff:text,milestone:text,revisitWhen:text}).strict().nullable()}).strict();
export type Enrollment = z.infer<typeof enrollmentSchema>;
export const eventSchema = z.object({key:safeId,projectId:safeId,registrationId:safeId,roundId:safeId,attemptId:safeId,producerId:safeId,sequence:z.number().int().positive().max(1000000),dependsOn:z.array(safeId).max(100),kind:z.enum(['received','begin','checkpoint','completed','failed','cancelled']),rawHash:sha,description:z.enum(['stream-start','turn-start','activity-observed','agent-report-retained-locally','turn-completed','turn-failed','cancelled']),observedAt:z.string().datetime(),sourceSnapshotId:safeId.nullable(),sourceTiming:z.literal('recovery-read-time').optional()}).strict();
export type RoundEvent = z.infer<typeof eventSchema>;
export interface SyncHistoryEntry { kind:'error'|'replay'|'recovered'; at:string; offset:number; line:number; cursor:number; prefixHash:string; maxRecordBytes:number|null; issue:string|null }
export interface Registration { syncHistory?:SyncHistoryEntry[]; delayedRecovery?:boolean; recoveryThroughOffset?:number|null; binding:Enrollment; bindingHash:string; createdAt:string; offset:number; prefixHash:string; fileIdentity:string|null; line:number; cursor:number; threadId:string|null; status:'waiting'|'following'|'caught-up'|'partial-line'|'sync-error'|'terminal'|'unsupported'; issue:string|null; lastReceivedAt:string|null; lastCheckedAt:string|null }
export interface RoundData { checkpoints?:{registrationId:string;snapshotId:string;sequence:number;createdAt:string}[]; snapshots:RoundSnapshot[]; registrations:Registration[]; events:{event:RoundEvent;payloadHash:string;receivedAt:string}[]; conflicts:{key:string;payloadHash:string;reason:string;createdAt:string}[]; revision:number }
export function roundData(s:Session):RoundData { return s.rounds??={snapshots:[],registrations:[],events:[],conflicts:[],revision:0}; }
export function evidenceFile(project:Project, ref:{rootIndex:number;path:string}):string {
 const root=project.evidenceRoots?.[ref.rootIndex];if(!root)throw new WorkflowError('EVIDENCE_ROOT_REFUSED','证据根未登记');
 const path=safePath(root,ref.path);if(!lstatSync(path).isFile())throw new WorkflowError('EVIDENCE_PATH_REFUSED','须为普通文件');return path;
}
export function sourceDelta(before:RoundSnapshot,after:RoundSnapshot) {
 const a=new Map(before.inventory.map(f=>[f.path,f])),b=new Map(after.inventory.map(f=>[f.path,f]));
 return [...new Set([...a.keys(),...b.keys()])].sort().flatMap(path=>a.get(path)?.sha256===b.get(path)?.sha256?[]:[{path,kind:!a.has(path)?'added':!b.has(path)?'deleted':'modified',before:a.get(path)?.sha256??null,after:b.get(path)?.sha256??null,bytesBefore:a.get(path)?.bytes??null,bytesAfter:b.get(path)?.bytes??null}]);
}
// All durable mutations share SessionStore's exclusive writer lease and atomic pointer.
export class RoundCoordinator {
 constructor(private store:SessionStore,private read:(id:string)=>Session,private project:(id:string)=>Project,private changed:(id:string)=>void=()=>{}) {}
 recheck(id:string){this.changed(id);}
 capture(id:string,deduplicate=false,session?:Session):RoundSnapshot { const source=discoverSource(this.project(id)),s=session??this.read(id),d=roundData(s);
  // Command completion is an observation boundary, not proof of command causality.
  // Reuse only the latest identical inventory; event.observedAt records this new read.
  const last=d.snapshots.at(-1);if(deduplicate&&last?.kind==='captured'&&last.sourceHash===source.hash)return last;const snap:RoundSnapshot={id:`snapshot-${hash([source.hash,source.observedAt,d.snapshots.length]).slice(0,32)}`,sourceHash:source.hash,inventory:source.inventory,observedAt:source.observedAt,importedAt:now(),kind:'captured',evidenceHash:null,partial:source.omitted.some(x=>x.reason!=='context limit'),coverage:source.scope};d.snapshots.push(snap);d.revision++;s.generation++;if(!session){this.store.save(s);this.changed(id);}return snap; }
 importSnapshot(id:string,raw:unknown):RoundSnapshot {
  const ref=recordRef.parse(raw),p=this.project(id),file=evidenceFile(p,ref);if(lstatSync(file).size>5_000_000)throw new WorkflowError('RECORD_LIMIT','快照记录过大');const bytes=readFileSync(file);if(digest(bytes)!==ref.sha256)throw new WorkflowError('EVIDENCE_HASH','快照原件 hash 不符');
  const input=z.object({sourceRoot:text,trackedHashes:z.record(sha),head:text.optional(),deliverables:z.array(text).optional(),observedAt:z.string().datetime().optional()}).strict().parse(JSON.parse(bytes.toString()));
  if(realpathSync(input.sourceRoot)!==p.sourceRoot)throw new WorkflowError('IDENTITY_UNRESOLVED','快照来自另一工作树');
  for(const path of Object.keys(input.trackedHashes))if(path.startsWith('/')||path.split(/[\\/]/).includes('..')||path.includes('\\')||path.includes('\0')||!path.length)throw new WorkflowError('SOURCE_PATH_REFUSED','快照路径越界');
  const inventory=Object.entries(input.trackedHashes).filter(([path])=>p.scope.some(scope=>contained(resolve(p.sourceRoot,scope),resolve(p.sourceRoot,path)))&&!p.exclude?.some(x=>contained(resolve(p.sourceRoot,x),resolve(p.sourceRoot,path)))&&!path.split('/').some(x=>['.git','node_modules','.codex','.agents'].includes(x))).map(([path,sha256])=>{
   if(path.startsWith('/')||path.split(/[\\/]/).includes('..')||path.includes('\\')||path.includes('\0')||!path.length)throw new WorkflowError('SOURCE_PATH_REFUSED','快照路径越界');return {path,sha256,bytes:null};
  }).sort((a,b)=>a.path.localeCompare(b.path));if(!inventory.length)throw new WorkflowError('SOURCE_EMPTY','快照没有登记范围内来源');
  const sourceHash=hash({projectId:id,root:p.sourceRoot,scope:p.scope,inventory}),snap:RoundSnapshot={id:`snapshot-${ref.sha256.slice(0,32)}`,sourceHash,inventory,observedAt:input.observedAt??null,importedAt:now(),kind:'historical-import',evidenceHash:ref.sha256,partial:true,coverage:p.scope};
  const s=this.read(id),d=roundData(s);const old=d.snapshots.find(x=>x.id===snap.id);if(old)return old;d.snapshots.push(snap);d.revision++;s.generation++;this.store.save(s);this.changed(id);return snap;
 }
 enroll(id:string,raw:unknown,selectedSessionObserver=false,session?:Session):Registration {
  const req=enrollmentSchema.parse(raw),p=this.project(id),s=session??this.read(id),d=roundData(s),bindingHash=hash(req),old=d.registrations.find(r=>r.binding.id===req.id);
  if(old){if(old.bindingHash!==bindingHash)throw new WorkflowError('REGISTRATION_CONFLICT','登记身份不可覆盖',409);return old;}
  if(req.projectId!==id||realpathSync(req.worktreeRoot)!==p.sourceRoot||realpathSync(req.repoRoot)!==p.sourceRoot)throw new WorkflowError('IDENTITY_UNRESOLVED','仅支持明确登记的同仓库工作树');
  const goal=s.goals.at(-1);if(goal?.hash!==req.goalHash||req.clauseIds.some(c=>!goal.clauses.some(x=>x.id===c)))throw new WorkflowError('STALE_GOAL','登记须绑定当前目标和条款',409);
  if(req.feedbackIds.some(f=>!s.feedback.some(x=>x.id===f))||req.selectedActionIds.some(a=>!s.actions.some(x=>x.id===a)))throw new WorkflowError('REFERENCE_UNRESOLVED','原反馈或所选建议不存在');
  const before=d.snapshots.find(x=>x.id===req.beforeSnapshotId);if(!before)throw new WorkflowError('BASELINE_REQUIRED','必须先捕获或导入真实基线');
  if(req.mode==='live'&&(before.kind!=='captured'||!selectedSessionObserver&&before.sourceHash!==discoverSource(p).hash))throw new WorkflowError('BASELINE_STALE','live 登记前须捕获当前来源');
  if(req.deferredBenefit&&req.deferredBenefit.goalHash!==req.goalHash)throw new WorkflowError('STALE_GOAL','延期收益目标不匹配');
  const existing=d.registrations.filter(r=>r.binding.roundId===req.roundId);
  if(d.registrations.some(r=>r.binding.producerId===req.producerId||r.binding.attemptId===req.attemptId))throw new WorkflowError('IDENTITY_CONFLICT','producer/attempt 已登记');
  if(existing.length){const last=existing.at(-1)!;const status=projectRounds(s).rounds.find(r=>r.id===req.roundId)?.status;if(!['failed','cancelled'].includes(status??'')||last.binding.taskId!==req.taskId||last.binding.goalHash!==req.goalHash||last.binding.purpose!==req.purpose)throw new WorkflowError('RECOVERY_REFUSED','同轮新 attempt 仅允许同目标、目的、任务的失败恢复');}
  // A missing stream is honest waiting; the containing evidence directory must already exist.
  const root=p.evidenceRoots?.[req.stream.rootIndex];if(!root)throw new WorkflowError('EVIDENCE_ROOT_REFUSED','事件根未登记');
  if(contained(this.store.root,resolve(realpathSync(root),req.stream.path)))throw new WorkflowError('ANALYZER_STREAM_REFUSED','分析器自己的数据目录不能登记为开发事件源');
  const parts=req.stream.path.split('/');const leaf=parts.pop()!;if(!/^[a-zA-Z0-9._-]+$/.test(leaf)||leaf==='..')throw new WorkflowError('SOURCE_PATH_REFUSED','事件路径无效');safePath(root,parts.join('/')||'.');
  try{const streamPath=evidenceFile(p,req.stream);if(req.mode==='live'&&!selectedSessionObserver&&lstatSync(streamPath).size>0)throw new WorkflowError('HISTORICAL_REPLAY_REQUIRED','已有事件流须标为历史回放；live 必须在生产者开始前登记');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const supported=req.toolVersion==='0.155.0-alpha.2.6'||req.toolVersion==='0.155.0-alpha.9.2';
  const r:Registration={binding:req,bindingHash,createdAt:now(),offset:0,prefixHash:digest(''),fileIdentity:null,line:0,cursor:0,threadId:null,status:supported?'waiting':'unsupported',issue:supported?null:'未验证工具版本；仅支持手工事件导入，自动跟随停用',lastReceivedAt:null,lastCheckedAt:null};d.registrations.push(r);d.revision++;s.generation++;if(!session){this.store.save(s);this.changed(id);}return r;
 }
 accept(id:string,raw:unknown,deferTerminal=false,session?:Session) {
  const event=eventSchema.parse(raw),s=session??this.read(id),d=roundData(s),r=d.registrations.find(x=>x.binding.id===event.registrationId),payloadHash=hash(event);
  if(!r||event.projectId!==id||event.roundId!==r.binding.roundId||event.attemptId!==r.binding.attemptId||event.producerId!==r.binding.producerId)throw new WorkflowError('IDENTITY_UNRESOLVED','事件身份与登记不符');
  if(event.sourceSnapshotId&&!d.snapshots.some(x=>x.id===event.sourceSnapshotId))throw new WorkflowError('REFERENCE_UNRESOLVED','来源快照不存在');
  const previous=d.events.find(x=>x.event.key===event.key),sameSequence=d.events.find(x=>x.event.producerId===event.producerId&&x.event.sequence===event.sequence);
  if(previous?.payloadHash===payloadHash)return {key:event.key,payloadHash,durable:true,cursor:r.cursor,duplicate:true};
  if(previous||sameSequence){d.conflicts.push({key:event.key,payloadHash,reason:'事件键或生产者序列冲突；原事件保留',createdAt:now()});if(!session){this.store.save(s);this.changed(id);}throw new WorkflowError('EVENT_CONFLICT','事件键或序列冲突',409);}
  if(event.dependsOn.includes(event.key))throw new WorkflowError('DEPENDENCY_CYCLE','事件不能依赖自身');
  d.events.push({event,payloadHash,receivedAt:now()});advanceCursors(d);
  if(!deferTerminal)for(const candidate of d.registrations){
   const accepted=d.events.filter(e=>e.event.registrationId===candidate.binding.id);
   if(candidate.status==='waiting'&&accepted.every(e=>e.event.sequence<=candidate.cursor)&&accepted.some(e=>e.event.kind==='begin')&&accepted.some(e=>['completed','failed','cancelled'].includes(e.event.kind)))candidate.status='terminal';
  }
  r.lastReceivedAt=now();d.revision++;s.generation++;if(!session){this.store.save(s);this.changed(id);}
  return {key:event.key,payloadHash,durable:true,cursor:r.cursor,duplicate:false};
 }
 update(id:string,registrationId:string,patch:Partial<Omit<Registration,'binding'|'bindingHash'|'createdAt'>>) { const s=this.read(id),r=roundData(s).registrations.find(x=>x.binding.id===registrationId);if(!r)throw new WorkflowError('REFERENCE_UNRESOLVED','登记不存在');if(!Object.entries(patch).some(([key,value])=>key!=='lastCheckedAt'&&JSON.stringify(r[key as keyof Registration])!==JSON.stringify(value)))return;Object.assign(r,patch);this.store.save(s);this.changed(id); }
 checkpoint(id:string,registrationId:string){const s=this.read(id),r=roundData(s).registrations.find(x=>x.binding.id===registrationId);if(!r)throw new WorkflowError('REFERENCE_UNRESOLVED','登记不存在');const snapshot=this.capture(id),fresh=this.read(id),seq=(roundData(fresh).checkpoints?.filter(x=>x.registrationId===registrationId).length??0)+1;
  // Manual snapshots never impersonate stream sequence numbers or historical event times.
  const current=roundData(fresh);current.checkpoints??=[];current.checkpoints.push({registrationId,snapshotId:snapshot.id,sequence:seq,createdAt:now()});current.revision++;this.store.save(fresh);this.changed(id);return snapshot;
 }
}
// Additional manually captured checkpoints are intentionally separate from producer events.
function advanceCursors(d:RoundData){let changed=true;while(changed){changed=false;const applied=new Set(d.events.filter(x=>{const r=d.registrations.find(r=>r.binding.producerId===x.event.producerId);return r&&x.event.sequence<=r.cursor;}).map(x=>x.event.key));for(const r of d.registrations){const next=d.events.find(x=>x.event.producerId===r.binding.producerId&&x.event.sequence===r.cursor+1);if(next&&next.event.dependsOn.every(k=>applied.has(k))){r.cursor++;changed=true;}}}}
export function projectRounds(s:Session,policy={window:3,noProofThreshold:3,addedBytesThreshold:20000},currentSourceHash?:string) {
 const d=roundData(s),goal=s.goals.at(-1);
 const rounds=[...new Set(d.registrations.map(r=>r.binding.roundId))].map(id=>{
  const attempts=d.registrations.filter(r=>r.binding.roundId===id),r=attempts.at(-1)!,b=r.binding,events=d.events.filter(e=>e.event.registrationId===b.id&&e.event.sequence<=r.cursor).map(e=>e.event),terminal=[...events].reverse().find(e=>['completed','failed','cancelled'].includes(e.kind));
  const observations=[...events.flatMap(e=>e.sourceSnapshotId?[{snapshotId:e.sourceSnapshotId,observedAt:e.observedAt}]:[]),...(d.checkpoints?.filter(c=>c.registrationId===b.id).map(c=>({snapshotId:c.snapshotId,observedAt:c.createdAt}))??[])];
  observations.sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)||d.snapshots.findIndex(s=>s.id===a.snapshotId)-d.snapshots.findIndex(s=>s.id===b.snapshotId));
  const latestObservation=observations.at(-1),before=d.snapshots.find(x=>x.id===attempts[0].binding.beforeSnapshotId)!,after=d.snapshots.find(x=>x.id===latestObservation?.snapshotId),deltas=after?sourceDelta(before,after):[];
  const pending=d.events.filter(e=>e.event.registrationId===b.id&&e.event.sequence>r.cursor).map(e=>({key:e.event.key,sequence:e.event.sequence,dependsOn:e.event.dependsOn}));
  const evidence=s.observations.filter(o=>after&&o.sourceHash===after.sourceHash&&o.goalHash===b.goalHash&&Date.parse(o.createdAt)>=Date.parse(after.observedAt??after.importedAt));
  const delayedRecovery=attempts.some(a=>a.delayedRecovery===true);
  const agentEvents=s.agentActivity?.events.filter(e=>e.roundId===id)??[];
  const childEvents=agentEvents.filter(e=>e.kind==='delegation'&&e.agentId!=='root');
  const unresolvedChildren=childEvents.some(e=>[...agentEvents].reverse().find(x=>x.agentId===e.agentId&&x.kind==='delegation')?.status!=='completed');
  const failedChildren=childEvents.some(e=>['failed','interrupted'].includes([...agentEvents].reverse().find(x=>x.agentId===e.agentId&&x.kind==='delegation')?.status??''));
  const qualifiedLegacy=evidence.filter(o=>o.qualified&&(o.roundIds?o.roundIds.includes(id):!delayedRecovery)),stale=b.goalHash!==goal?.hash;
  const matchingView=[...s.views].reverse().find(v=>v.source.hash===after?.sourceHash&&v.goal?.hash===b.goalHash&&Date.parse(v.createdAt)>=Date.parse(after?.observedAt??after?.importedAt??''))??null;
  const touchedTargets=matchingView?[...matchingView.analysis.modules,...matchingView.analysis.edges].filter(t=>t.refs.some(ref=>deltas.some(f=>f.path===ref.path))).map(t=>t.id):[];
  const conditionProgress=projectClosedLoop({...s,verificationReceipts:(s.verificationReceipts??[]).filter(v=>v.binding.roundId===id)},after?.sourceHash??'unknown',false);
  const sourceStale=!!after&&(currentSourceHash??d.snapshots.filter(x=>x.kind==='captured').at(-1)?.sourceHash)!==after.sourceHash;
  const proofEligible=!stale&&!sourceStale&&!pending.length;
  const qualified=proofEligible?qualifiedLegacy:[];
  const conditionVerified=proofEligible?conditionProgress.criteria.filter(c=>c.evidence.some(e=>e.current)).map(c=>({criterionId:c.criterionId,scenarioId:c.scenarioId,text:c.text,result:c.status,recovered:c.recovered,mapping:c.mapping,targetIds:c.targetIds,clauseIds:c.clauseIds,receiptIds:[...new Set(c.evidence.filter(e=>e.current).map(e=>e.receiptId))]})):[];
  const conditionEvidenceCount=proofEligible?conditionProgress.receipts.filter(v=>v.current).length:0;
  const remaining=pending.length?'事件存在缺号或依赖等待':stale?'需按新目标重审本轮目的':sourceStale?'来源已变化；本轮证据不能证明当前实现':conditionVerified.some(c=>!['passed','unknown'].includes(c.result))||qualified.some(o=>o.result==='failed')?'限定验证仍失败':conditionProgress.confirmation?`确认条件 ${conditionVerified.filter(c=>c.result==='passed').length}/${conditionProgress.criteria.length} 通过；${conditionProgress.criteria.filter(c=>c.status!=='passed'||c.mapping!=='mapped').map(c=>c.text).join('；')||'整体旅程仍须核对'}`:!qualified.length?'实际变化尚缺行为验证':'已有范围证据；整体旅程仍须核对';
  const currentRecommendation=matchingView?.generation===s.generation?matchingView?.analysis.diagnosis?.recommendation.action:undefined;
  const next=!proofEligible?pending.length?'补齐本轮缺号或依赖事件':stale?'按新目标核对本轮目的与条件':'重新观察当前来源并验证对应条件':conditionProgress.criteria.some(c=>c.status!=='passed')?`验证条件：${conditionProgress.criteria.find(c=>c.status!=='passed')!.text}`:conditionProgress.criteria.some(c=>c.mapping!=='mapped')?'核对尚未定位的条件与条款、旅程及实现映射':currentRecommendation??'按当前目标、来源和证据核对整体旅程与下一轮建议';
  return {id,sourceStale,proofEligible,conditionVerified,conditionEvidenceCount,legacyEvidenceCount:evidence.length,conditionProgress:{status:!proofEligible?'stale':conditionProgress.status,criteria:conditionProgress.criteria,gapProgress:conditionProgress.gapProgress},scenarioConfirmations:(s.scenarioSets??[]).filter(c=>c.status==='confirmed'&&c.goalHash===b.goalHash&&(c.roundId===id||(s.verificationReceipts??[]).some(v=>v.binding.roundId===id&&v.binding.confirmationId===c.id))).map(c=>({id:c.id,hash:c.hash,goalVersion:c.goalVersion,roundId:c.roundId})),verificationReceipts:(s.verificationReceipts??[]).filter(v=>v.binding.roundId===id).map(v=>({id:v.id,sourceHash:v.binding.sourceHash,goalHash:v.binding.goalHash,confirmationId:v.binding.confirmationId,current:proofEligible&&conditionProgress.receipts.some(r=>r.id===v.id&&r.current),checks:v.checks.map(c=>({id:c.id,assertions:c.assertions}))})),delayedRecovery,sourceCoverage:delayedRecovery?'恢复读取时观察；历史源码覆盖和命令归因未知，可能包含后续轮次修改。后续无轮次范围的验证不计入本轮进展。':'按登记检查点观察；不证明命令因果',taskId:b.taskId,purpose:b.purpose,goalHash:b.goalHash,clauseIds:b.clauseIds,journeyIds:b.journeyIds,feedbackIds:b.feedbackIds,acceptedPlan:b.acceptedPlan,selectedActionIds:b.selectedActionIds,deferredBenefit:b.deferredBenefit,mode:b.mode,attempts:attempts.map(a=>({id:a.binding.attemptId,registrationId:a.binding.id,beforeSnapshotId:a.binding.beforeSnapshotId,status:a.status,outcome:[...d.events].reverse().find(e=>e.event.registrationId===a.binding.id&&e.event.sequence<=a.cursor&&['completed','failed','cancelled'].includes(e.event.kind))?.event.kind??'incomplete',cursor:a.cursor,issue:a.issue,syncHistory:a.syncHistory??[]})),status:failedChildren&&terminal?.kind==='completed'?'agent-failed':unresolvedChildren&&terminal?.kind==='completed'?'agent-unknown':terminal?.kind??(events.some(e=>e.kind==='begin')?'running':'waiting'),stale,relevance:stale?'目标已改变；保留工作，须重新核对目的':'绑定当前目标；语义适用性仍由分析核对',before,after:after??null,lastSourceObservedAt:after?.kind==='historical-import'?after.observedAt:latestObservation?.observedAt??null,deltas,pending,reported:events.some(e=>e.description==='agent-report-retained-locally')?'代理报告原件已收到，内容仅保留在授权证据根；尚不等于验证修复':'尚未收到代理结果报告',verified:qualified.map(o=>({id:o.id,result:o.result,targetIds:o.targetIds,clauseIds:o.clauseIds,rawHash:o.rawHash,roundIds:o.roundIds??null,scopeSummary:o.scopeSummary??null,limitations:o.limitations??null})),evidenceCount:(proofEligible?evidence.length:0)+conditionEvidenceCount,viewAttemptId:matchingView?.attemptId??null,gapIds:matchingView?.gaps.filter(g=>g.lifecycle==='open').map(g=>g.id)??[],touchedTargets,mapping:matchingView?'当前源与目标绑定的模块/连接引用':'unknown：尚无匹配本轮来源与目标的分析',remaining,next,observedBegin:events.some(e=>e.kind==='begin'),eventCount:events.length};
 });
 const window=rounds.slice(-policy.window),coverageComplete=window.length>=policy.window&&window.every(r=>!r.stale&&!r.sourceStale&&!r.delayedRecovery&&r.mode==='live'&&r.observedBegin&&r.after&&!r.pending.length&&['completed','failed','cancelled'].includes(r.status)&&!r.attempts.some(a=>['sync-error','unsupported','waiting','partial-line'].includes(a.status)));
 const repeatedGaps=[...new Set(window.flatMap(r=>r.gapIds))].filter(id=>window.filter(r=>r.gapIds.includes(id)).length>=policy.noProofThreshold);
 const noProof=window.filter(r=>!r.verified.some(e=>e.result==='passed')&&!r.conditionVerified.some(e=>e.result==='passed'&&e.mapping==='mapped')).length,addedBytes=window.flatMap(r=>r.deltas).reduce((n,f)=>n+Math.max(0,(f.bytesAfter??0)-(f.bytesBefore??0)),0);
 return {revision:d.revision,rounds,snapshots:d.snapshots.map(({inventory,...x})=>({...x,fileCount:inventory.length})),registrations:d.registrations.map(r=>({id:r.binding.id,tool:r.binding.tool,toolVersion:r.binding.toolVersion,branch:r.binding.branch,mode:r.binding.mode,status:r.status,issue:r.issue,syncHistory:r.syncHistory??[],delayedRecovery:r.delayedRecovery??false,recoveryThroughOffset:r.recoveryThroughOffset??null,cursor:r.cursor,line:r.line,lastReceivedAt:r.lastReceivedAt,lastCheckedAt:r.lastCheckedAt,backlog:'unknown',connected:false,coverage:'仅登记的 Codex JSONL；caught-up 不证明生产者仍在线'})),policy:{...policy,version:'round-investigation.v1',coverageComplete,noProof,addedBytes,repeatedGaps,signal:!coverageComplete?'缺观察，先补齐范围；不能判定偏离':noProof>=policy.noProofThreshold||addedBytes>=policy.addedBytesThreshold||repeatedGaps.length>0?'建议调查共同瓶颈、重复差距及复杂度的验证收益；不自动改计划':'继续按关键旅程收集验证'},conflicts:d.conflicts};
}
export function diagnosisState(view:View|null,goalHash:string|undefined,latestSourceHash?:string,generation?:number){return !view?'not-analyzed':view.goal?.hash!==goalHash||latestSourceHash&&view.source.hash!==latestSourceHash||generation!==undefined&&view.generation!==generation?'stale':view.analysis.diagnosis?'published':'legacy-unknown';}

// Only source/goal/task/evidence facts enter this binding. Cursor timestamps,
// standalone snapshots, projected model recommendations and job bookkeeping do not.
export function analysisRoundContext(s:Session,policy={window:3,noProofThreshold:3,addedBytesThreshold:20000}) {
 const d:RoundData=s.rounds??{snapshots:[],registrations:[],events:[],conflicts:[],revision:0};
 return {policy,registrations:d.registrations.map(r=>({binding:r.binding,cursor:r.cursor,
   issue:r.issue,syncHistory:r.syncHistory??[],delayedRecovery:r.delayedRecovery??false,sourceCoverage:r.delayedRecovery?'recovery-read-time; historical source and command attribution unknown; round progress requires explicit observation roundIds':'checkpoint observations only',unsupported:r.status==='unsupported',incomplete:r.status==='partial-line'||r.status==='sync-error'})),
   events:d.events.map(e=>e.event),checkpoints:d.checkpoints??[],
   snapshots:d.snapshots.filter(x=>d.registrations.some(r=>r.binding.beforeSnapshotId===x.id)||d.events.some(e=>e.event.sourceSnapshotId===x.id)||d.checkpoints?.some(c=>c.snapshotId===x.id)),conflicts:d.conflicts};
}
export interface RoundAnalysisJob {
 id:string;triggerHash:string;roundIds:string[];sourceHash:string;goalHash:string|null;evidenceHash:string;
 state:'pending'|'running'|'completed'|'failed'|'cancelled'|'interrupted';createdAt:string;
 attemptId?:string;endedAt?:string;error?:string;
}
export interface RoundAnalysisState { seen:Record<string,string>; jobs:RoundAnalysisJob[] }
export function eligibleRoundTriggers(s:Session,historical:boolean) {
 const d=roundData(s),projection=projectRounds(s);
 return projection.rounds.flatMap(round=>{
  const registration=d.registrations.find(r=>r.binding.id===round.attempts.at(-1)?.registrationId)!;
  if((round.mode==='historical-replay'&&!historical)||!round.observedBegin||!round.after||round.pending.length||
    !['completed','failed','cancelled'].includes(round.status)||registration.status!=='terminal'||registration.issue)return [];
  const events=d.events.filter(e=>e.event.registrationId===registration.binding.id);
  if(events.some(e=>e.event.sequence>registration.cursor)||d.conflicts.some(c=>events.some(e=>e.event.key===c.key)))return [];
  return [{registrationId:registration.binding.id,roundId:round.id,signature:hash({binding:registration.bindingHash,
    events:events.map(e=>e.payloadHash),after:round.after.id,evidence:s.observations.map(o=>[o.id,o.rawHash,o.qualified])})}];
 });
}
