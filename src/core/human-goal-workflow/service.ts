import { activeConfirmation, validateScenarios, projectClosedLoop } from './scenarios.js';
import { verificationContext, validateReceipt } from './verification.js';
import { readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RoundCoordinator, recordRef, evidenceFile, analysisRoundContext, eligibleRoundTriggers } from './rounds.js';
import { CodexEventFollower } from './codex-events.js';
import { CodexSessionObserver } from './codex-session.js';
import { appendMainlineAnnotation } from './mainline-progress.js';
import { SessionStore } from './store.js';
import { contained, discoverSource, safePath } from './source.js';
import { CodexAnalyzer, validateAnalysis } from './analyzer.js';
import { scenarioListSchema, clauseSchema, configSchema, safeId, text, hash, digest, schemaVersion, WorkflowError, type Config, type Project, type Session, type Analyzer, type AnalysisInput, type Attempt, type GapView, type View, type Observation } from './types.js';
const now = () => new Date().toISOString();
const expectationSchema = z.object({targetId:safeId,responsibility:text,inputs:z.array(text).max(30),outputs:z.array(text).max(30),examples:z.array(text).max(30),clauseIds:z.array(safeId).min(1).max(50),disposition:z.enum(['required','optional','unnecessary','proposed-missing']),replaces:z.array(safeId).max(30)}).strict();
export const feedbackSchema = z.object({expectedGeneration:z.number().int().nonnegative(),idempotencyKey:safeId,originalText:text,kind:z.enum(['interpretation-correction','desired-change','evidence-contribution']),targetIds:z.array(safeId).max(50).default([]),author:text,provenance:text,clauses:z.array(clauseSchema).min(1).max(50).optional(),expectation:expectationSchema.optional(),supersedes:safeId.optional(),analyze:z.boolean().default(true)}).strict();
const analyzeSchema = z.object({expectedGeneration:z.number().int().nonnegative(),idempotencyKey:safeId}).strict();
const rawCriterionProvenance = '自动完整原文核对项：逐字保留目标原文；未作语义拆解，未经人类逐条确认。';
// A provenance marker identifies the automatic criterion without reassigning human clause IDs.
const isRawCriterion = (c:z.infer<typeof clauseSchema>) => c.id.startsWith('raw-goal-') && c.constraints.includes(rawCriterionProvenance);
export class HumanGoalService {
  readonly rounds: RoundCoordinator; readonly follower: CodexEventFollower; readonly activity: CodexSessionObserver; readonly config: Config; readonly store: SessionStore; private analyzer: Analyzer; private queue = Promise.resolve(); private controllers = new Map<string,AbortController>(); private closing=false; private roundDrainQueued=false;
  constructor(rawConfig: unknown, analyzer?: Analyzer, private options={dispatchRoundAnalysis:true}) {
    this.config = configSchema.parse(rawConfig); this.analyzer=analyzer??new CodexAnalyzer(this.config.analyzer);
    if (new Set(this.config.projects.map(p=>p.id)).size !== this.config.projects.length) throw new WorkflowError('IDENTITY_UNRESOLVED','项目 ID 重复');
    mkdirSync(resolve(this.config.dataDir),{recursive:true}); const data = realpathSync(this.config.dataDir), repo = realpathSync(resolve(new URL('../../../',import.meta.url).pathname));
    for (const p of this.config.projects) { p.sourceRoot=realpathSync(p.sourceRoot); for (const scope of p.scope) safePath(p.sourceRoot,scope); if(contained(p.sourceRoot,data)||contained(data,p.sourceRoot)) throw new WorkflowError('DATA_SCOPE_REFUSED','数据目录必须在源范围之外且不能包含源'); }
    if (contained(repo,data)) throw new WorkflowError('DATA_SCOPE_REFUSED','数据目录必须在 Project OS 仓库之外');
    for(const [id,checks] of Object.entries(this.config.verificationChecks)){if(!this.config.projects.some(p=>p.id===id)||new Set(checks.map(c=>c.id)).size!==checks.length)throw new WorkflowError('CHECK_REGISTRY','检查登记项目未知或 ID 重复');}
    this.store=new SessionStore(data);
    this.rounds=new RoundCoordinator(this.store,id=>this.read(id),id=>this.project(id),id=>this.reconcileRoundAnalysis(id));this.follower=new CodexEventFollower(this.rounds,id=>this.read(id),id=>this.project(id),()=>this.config.projects.map(p=>p.id),this.config.eventReadPolicy);
    this.activity=new CodexSessionObserver(this.store,this.rounds,id=>this.read(id),id=>this.project(id),()=>this.config.projects.map(p=>p.id),this.config.eventReadPolicy.maxRecordBytes);
    try { for (const id of this.store.list()) this.store.interruptActive(id); } catch(e) { this.store.close(); throw e; }
    for(const id of this.store.list())this.reconcileRoundAnalysis(id);
  }
  project(id:string): Project { const p=this.config.projects.find(p=>p.id===id); if(!p)throw new WorkflowError('PROJECT_UNKNOWN','只允许已登记项目',404);return p; }
  read(id:string): Session { const p=this.project(id); const state=this.store.load(id); if(state){if(state.registryHash!==hash(p))throw new WorkflowError('IDENTITY_UNRESOLVED','项目登记身份已改变，不能覆盖现有会话',409);return state;} return {schemaVersion,projectId:id,registryHash:hash(p),generation:0,goals:[],feedback:[],expectations:[],observations:[],attempts:[],views:[],currentView:null,conflicts:[],idempotency:{},actions:[]}; }
  private cas(state:Session,generation:number,request:unknown) { if(state.generation!==generation) { state.conflicts.push({request,reason:'STALE_BASE',createdAt:now()});this.store.save(state);throw new WorkflowError('STALE_BASE','另一操作已更新状态；原文已保留，读取新版本后显式合并',409,{retainedGeneration:state.generation,request}); } }
  private replay(state:Session,key:string,payload:unknown): unknown { const previous=state.idempotency[key];if(!previous)return undefined;if(previous.payloadHash!==hash(payload))throw new WorkflowError('IDEMPOTENCY_CONFLICT','同一个请求键不能用于不同内容',409);return previous.result; }
  private remember(state:Session,key:string,payload:unknown,result:unknown){state.idempotency[key]={payloadHash:hash(payload),result};this.store.save(state);return result;}
  feedback(id:string,raw:unknown): unknown {
    const req=feedbackSchema.parse(raw), s=this.read(id), prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);
    const view=s.currentView===null?null:s.views[s.currentView], valid=new Set(view?.analysis.modules.map(m=>m.id)??[]);
    for(const target of req.targetIds) if(!valid.has(target)&&req.expectation?.disposition!=='proposed-missing')throw new WorkflowError('REFERENCE_UNRESOLVED','反馈目标不存在');
    if(req.supersedes&&!s.feedback.some(f=>f.id===req.supersedes))throw new WorkflowError('REFERENCE_UNRESOLVED','被纠正分类的反馈不存在');
    if(req.expectation&&req.kind!=='desired-change')throw new WorkflowError('GOAL_CONFLICT','解释纠正不会改写模块期望；请分开提交期望改变');
    if(req.clauses&&req.kind!=='desired-change')throw new WorkflowError('GOAL_CONFLICT','解释纠正和事实贡献不能改写人类目标');
    if(req.clauses || (req.kind==='desired-change' && !req.expectation && req.targetIds.length===0)){
      const previous=s.goals.at(-1);
      let clauses=structuredClone(req.clauses??previous?.clauses??[]),provenance=req.provenance;
      if(new Set(clauses.map(c=>c.id)).size!==clauses.length)throw new WorkflowError('GOAL_CONFLICT','目标条款 ID 重复');
      const rawChanged=previous?.originalText!==req.originalText;
      for(const automatic of clauses.filter(isRawCriterion)){
        const old=previous?.clauses.find(c=>c.id===automatic.id&&isRawCriterion(c));
        if(automatic.text!==req.originalText&&automatic.text!==old?.text)throw new WorkflowError('GOAL_CONFLICT','自动完整原文核对项请通过原话更新；详细条款可单独编辑');
      }
      // An unchanged form must not silently restrict a newly supplied intention to old criteria.
      // Explicitly edited detailed clauses retain their IDs, content and scope semantics.
      if(!req.clauses || (previous && hash(clauses)===hash(previous.clauses) && (rawChanged || !clauses.some(c=>c.text===req.originalText)))){
        const automatic=clauses.find(isRawCriterion);
        if(automatic)automatic.text=req.originalText;
        else {
          if(clauses.length>=50)throw new WorkflowError('GOAL_CONFLICT','原文核对项需要一个条款位置；请合并一条详细条款后重试，原目标尚未更改');
          clauses.push({id:`raw-goal-${randomUUID()}`,text:req.originalText,importance:'core',constraints:[rawCriterionProvenance],examples:[]});
        }
      }
      // Retained automatic criteria follow the original even when detailed clauses are edited too.
      for(const automatic of clauses.filter(isRawCriterion))automatic.text=req.originalText;
      if(clauses.some(isRawCriterion))provenance+=`\n${rawCriterionProvenance} 既有详细条款保留，需核对是否仍符合新目标。`;
      if(s.expectations.length){(s.expectationHistory??=[]).push({goalHash:previous?.hash??null,expectations:structuredClone(s.expectations),createdAt:now()});s.expectations=[];}
      const base={id:`goal-${s.goals.length+1}`,version:s.goals.length+1,originalText:req.originalText,clauses,author:req.author,provenance,createdAt:now()};s.goals.push({...base,hash:hash(base)});
    }
    if(req.expectation){const clauses=s.goals.at(-1)?.clauses??[];if(req.expectation.clauseIds.some(id=>!clauses.some(c=>c.id===id)))throw new WorkflowError('GOAL_CONFLICT','模块期望必须指向现有父目标条款');for(const old of req.expectation.replaces)if(!valid.has(old))throw new WorkflowError('REFERENCE_UNRESOLVED','拆并原节点不存在');s.expectations=s.expectations.filter(e=>e.targetId!==req.expectation!.targetId);s.expectations.push(req.expectation);}
    const feedbackId=`feedback-${randomUUID()}`;
    s.feedback.push({id:feedbackId,originalText:req.originalText,kind:req.kind,targetIds:req.targetIds,author:req.author,provenance:req.provenance,createdAt:now(),goalVersion:s.goals.at(-1)?.version??null,classification:'confirmed',...(req.supersedes?{supersedes:req.supersedes}:{}),...(req.expectation?{expectation:req.expectation}:{})});s.generation++;
    const result={feedbackId,generation:s.generation,analysisRequired:true};this.remember(s,req.idempotencyKey,req,result);
    if(req.analyze) { try { const job=this.analyze(id,{expectedGeneration:s.generation,idempotencyKey:`analysis-${feedbackId}`});const response={...result,job};const current=this.read(id);this.remember(current,req.idempotencyKey,req,response);return response; } catch(e) { const response={...result,analysisError:String(e)};const current=this.read(id);this.remember(current,req.idempotencyKey,req,response);return response; } } return result;
  }
  private input(s:Session,source=discoverSource(this.project(s.projectId))): AnalysisInput {
    const previous=s.currentView===null?null:s.views[s.currentView];
    const {receipts,...closedLoop}=projectClosedLoop(s,source.hash,s.currentView!==null&&this.viewIsCurrent(s,s.views[s.currentView]));
    const base={scenarioSet:activeConfirmation(s),closedLoop,...(s.rounds?{rounds:analysisRoundContext(s,this.config.roundPolicy)}:{}),schemaVersion,project:this.project(s.projectId),source,goal:s.goals.at(-1)??null,expectations:s.expectations,feedback:s.feedback,observations:s.observations.map(o=>({...o,scopeSummary:o.scopeSummary??null,limitations:o.limitations??null,rawRecord:`local original SHA256 ${o.rawHash}`,invocation:{kind:'local-evidence-reference',rawHash:o.rawHash}})),previous:previous?.analysis??null,previousSourceHash:previous?.source.hash??null,generation:s.generation,analyzerRevision:this.analyzer.revision,configHash:hash(this.config.analyzer),plan:{reason:s.feedback.at(-1)?.targetIds.length?'模块反馈：重新读取来源及依赖；影响闭包未知，扩大到已登记范围':'初读或整体目标变化：重新检查全部条款与来源',targetIds:s.feedback.at(-1)?.targetIds??[],sourcePaths:source.files.map(f=>f.path),reuse:s.observations.filter(o=>o.sourceHash===source.hash).map(o=>o.id),limitations:['仅静态来源理解；未执行 subject','只对已登记范围形成判断；缺行不是缺失实现',...(source.readGaps??[]).map(g=>`未读 ${g.path}:${g.start}-${g.end}（${g.reason}）`),...source.omitted.map(g=>`未提供 ${g.path}（${g.reason}）`)]}};
    return {...base,snapshotCountAtRead:s.rounds?.snapshots.length??0,materialHash:this.materialHash(s,source),inputHash:hash({...base,source:{...source,observedAt:undefined}})};
  }
  private materialHash(s:Session,source:AnalysisInput['source']):string {
    return hash({project:this.project(s.projectId),source:{...source,observedAt:undefined},goal:s.goals.at(-1)??null,
      scenarioSet:activeConfirmation(s),verificationReceipts:s.verificationReceipts??[],feedback:s.feedback,expectations:s.expectations,observations:s.observations,
      rounds:analysisRoundContext(s,this.config.roundPolicy),
      analyzerRevision:this.analyzer.revision,configHash:hash(this.config.analyzer)});
  }
  viewIsCurrent(s:Session,view:View):boolean {
    const a=s.attempts.find(a=>a.id===view.attemptId),snapshots=s.rounds?.snapshots??[];
    // Use durable append order for new inputs; wall clocks may share a millisecond.
    const newer=a?.input.snapshotCountAtRead!==undefined?snapshots.slice(a.input.snapshotCountAtRead):snapshots.filter(x=>Date.parse(x.observedAt??x.importedAt)>Date.parse(view.source.observedAt));
    const latest=newer.filter(x=>x.kind==='captured').at(-1)?.sourceHash;
    if(view.goal?.hash!==s.goals.at(-1)?.hash||latest&&view.source.hash!==latest)return false;
    return a?.input.materialHash?this.materialHash(s,a.input.source)===a.input.materialHash:view.generation===s.generation;
  }
  // Persist an opt-in request before scheduling. A signature is consumed once even
  // when its provider fails or is cancelled; only new terminal/evidence facts enqueue.
  reconcileRoundAnalysis(id:string) {
    if(this.closing||!this.config.roundAnalysis.enabled)return;
    const s=this.read(id),triggers=eligibleRoundTriggers(s,this.config.roundAnalysis.historical);
    const state=s.roundAnalysis??{seen:{},jobs:[]},changed=triggers.filter(t=>state.seen[t.registrationId]!==t.signature);
    let dirty=false;
    for(const job of state.jobs.filter(j=>j.state==='running')){
      const a=s.attempts.find(a=>a.id===job.attemptId);
      if(a&&!['queued','running'].includes(a.state)){job.state=a.state==='interrupted'?'interrupted':a.state==='failed'?'failed':'completed';job.error=a.error;job.endedAt=a.endedAt;dirty=true;}
    }
    if(changed.length){
      const sourceHash=s.rounds!.snapshots.at(-1)!.sourceHash;
      let job=state.jobs.find(j=>j.state==='pending');
      if(!job){job={id:`round-analysis-${randomUUID()}`,triggerHash:'',roundIds:[],sourceHash,goalHash:null,evidenceHash:'',state:'pending',createdAt:now()};state.jobs.push(job);}
      for(const t of changed){state.seen[t.registrationId]=t.signature;if(!job.roundIds.includes(t.roundId))job.roundIds.push(t.roundId);}
      job.triggerHash=hash(state.seen);job.sourceHash=sourceHash;job.goalHash=s.goals.at(-1)?.hash??null;job.evidenceHash=hash(s.observations);dirty=true;
    }
    if(dirty){s.roundAnalysis=state;this.store.save(s);}
    if(state.jobs.some(j=>j.state==='pending'))this.drainRoundAnalysis();
  }
  private finishRoundAnalysis(id:string,aid:string){
    const s=this.read(id),job=s.roundAnalysis?.jobs.find(j=>j.attemptId===aid),a=s.attempts.find(a=>a.id===aid);
    if(!job||!a)return;
    job.state=a.state==='interrupted'?'cancelled':a.state==='failed'?'failed':'completed';job.error=a.error;job.endedAt=a.endedAt;
    // A successful but stale result may need the latest input; provider failure or
    // cancellation never grants a retry. A distinct pending input is coalesced.
    if(!this.closing&&a.result&&a.error?.startsWith('STALE_RESULT')&&!s.roundAnalysis!.jobs.some(j=>j.state==='pending')){
      const input=this.input(s);
      if(input.materialHash!==a.input.materialHash)s.roundAnalysis!.jobs.push({id:`round-analysis-${randomUUID()}`,triggerHash:input.materialHash!,roundIds:job.roundIds,sourceHash:input.source.hash,goalHash:input.goal?.hash??null,evidenceHash:hash(s.observations),state:'pending',createdAt:now()});
    }
    this.store.save(s);
  }
  private drainRoundAnalysis(){
    if(this.closing||this.roundDrainQueued||!this.options.dispatchRoundAnalysis)return;this.roundDrainQueued=true;
    this.queue=this.queue.then(async()=>{
      if(this.closing)return;
      for(const id of this.store.list()){
        const s=this.read(id),job=s.roundAnalysis?.jobs.find(j=>j.state==='pending');
        if(!job||s.attempts.some(a=>['queued','running'].includes(a.state)))continue;
        // Rebind at dispatch, after any feedback or earlier model has settled.
        // The immutable attempt retains the exact input actually sent to the model.
        try{
          const eligible=eligibleRoundTriggers(s,this.config.roundAnalysis.historical);
          if(job.roundIds.some(roundId=>!eligible.some(t=>t.roundId===roundId)))throw new WorkflowError('ROUND_INCOMPLETE','终局上下文已变化或存在同步错误；自动分析停止，保留请求');
          const input=this.input(s),aid=`attempt-${randomUUID()}`;
          job.sourceHash=input.source.hash;job.goalHash=input.goal?.hash??null;job.evidenceHash=hash(s.observations);
          // A feedback analysis may already have covered the coalesced request.
          const covered=[...s.attempts].reverse().find(a=>a.promoted&&a.input.materialHash===input.materialHash);
          if(covered){job.state='completed';job.attemptId=covered.id;job.endedAt=now();this.store.save(s);continue;}
          job.state='running';job.attemptId=aid;
          s.attempts.push({id:aid,parentAttemptId:null,state:'queued',input,createdAt:now(),usedMs:0,totalBudgetMs:this.config.analyzer.timeoutMs,attemptNumber:1,promoted:false,rawDir:this.store.attemptDir(id,aid)});
          this.store.save(s);await this.run(id,aid);
        }catch(e){const fresh=this.read(id),failed=fresh.roundAnalysis?.jobs.find(j=>j.id===job.id);if(failed){failed.state='failed';failed.error=String(e);failed.endedAt=now();const attempt=fresh.attempts.find(a=>a.id===failed.attemptId);if(attempt&&['queued','running'].includes(attempt.state)){attempt.state='failed';attempt.error=String(e);attempt.endedAt=failed.endedAt;}this.store.save(fresh);}}
      }
    }).finally(()=>{this.roundDrainQueued=false;if(!this.closing)for(const id of this.store.list()){
      const s=this.read(id);if(!s.attempts.some(a=>['queued','running'].includes(a.state)))this.reconcileRoundAnalysis(id);
    }});
  }
  analyze(id:string,raw:unknown): unknown {
    if(this.closing)throw new WorkflowError('INTERRUPTED','服务正在停止',409);
    const req=analyzeSchema.parse(raw),s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);
    const input=this.input(s), attemptId=`attempt-${randomUUID()}`,a:Attempt={id:attemptId,parentAttemptId:null,state:'queued',input,createdAt:now(),usedMs:0,totalBudgetMs:this.config.analyzer.timeoutMs,attemptNumber:1,promoted:false,rawDir:this.store.attemptDir(id,attemptId)};
    s.attempts.push(a);const result={attemptId,generation:s.generation,inputHash:input.inputHash,state:a.state};this.remember(s,req.idempotencyKey,req,result);this.schedule(id,attemptId);return result;
  }
  retry(id:string,raw:unknown):unknown {
    if(this.closing)throw new WorkflowError('INTERRUPTED','服务正在停止',409);
    const req=z.object({expectedGeneration:z.number().int(),idempotencyKey:safeId,attemptId:safeId,recoveryBasis:text}).strict().parse(raw),s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);
    const old=s.attempts.find(a=>a.id===req.attemptId);if(!old||!['failed','interrupted'].includes(old.state))throw new WorkflowError('RECOVERY_REFUSED','只能显式恢复失败或中断的 attempt');
    if(/PLATFORM_STOP|permission|denied|approval|unauthorized/i.test(old.error??''))throw new WorkflowError('PLATFORM_STOP','权限或平台停止需由实际执行环境处理，不能本地重试绕过',409);
    const fresh=this.input(s);if(fresh.inputHash!==old.input.inputHash)throw new WorkflowError('STALE_BASE','目标、来源或绑定已改变，请提交新分析并保留旧失败',409);
    const remaining=old.totalBudgetMs===null?null:old.totalBudgetMs-old.usedMs;if((remaining!==null&&remaining<1000)||old.attemptNumber>=this.config.analyzer.maxAttempts)throw new WorkflowError('BUDGET_EXHAUSTED','同一请求剩余预算或尝试次数不足',409);
    const aid=`attempt-${randomUUID()}`,a:Attempt={...old,id:aid,parentAttemptId:old.id,state:'queued',createdAt:now(),startedAt:undefined,endedAt:undefined,result:undefined,error:undefined,promoted:false,rawDir:this.store.attemptDir(id,aid),attemptNumber:old.attemptNumber+1,recoveryBasis:req.recoveryBasis};s.attempts.push(a);const result={attemptId:aid,inputHash:a.input.inputHash};this.remember(s,req.idempotencyKey,req,result);this.schedule(id,aid);return result;
  }
  private schedule(id:string,aid:string){this.queue=this.queue.then(()=>this.run(id,aid)).catch(e=>{ /* Preserve unexpected scheduler failure without inventing a result. */ const s=this.read(id),a=s.attempts.find(a=>a.id===aid);if(a){a.state='failed';a.error=String(e);a.endedAt=now();this.store.save(s);} }).finally(()=>this.reconcileRoundAnalysis(id));}
  private async run(id:string,aid:string) {
    let s=this.read(id); const original=s.attempts.find(a=>a.id===aid)!; if(original.state!=='queued')return;
    if(this.closing){original.state='interrupted';original.error='服务停止，尚未执行';this.store.save(s);return;}
    original.state='running';original.startedAt=now();original.elapsedAccounting??='measured';this.store.save(s);const controller=new AbortController();this.controllers.set(aid,controller);const started=Date.now();
    try {
      writeFileSync(join(original.rawDir,'bound-input.json'),JSON.stringify(original.input,null,2));
      // Every attempt rereads actual source; stored excerpts are not relabeled as new observation.
      const fresh=discoverSource(this.project(id));if(fresh.hash!==original.input.source.hash)throw new WorkflowError('REVISION_MISMATCH','排队后来源已改变，请重新分析');
      writeFileSync(join(original.rawDir,'source-read.json'),JSON.stringify(fresh,null,2));
      const raw=await this.analyzer.analyze(original.input,original.rawDir,controller.signal,original.totalBudgetMs===null?null:original.totalBudgetMs-original.usedMs);
      writeFileSync(join(original.rawDir,'returned-output.json'),JSON.stringify(raw,null,2));
      const result=validateAnalysis(raw,original.input);
      s=this.read(id);const a=s.attempts.find(a=>a.id===aid)!;a.result=result;a.state=original.input.source.partial?'partial':'completed';a.endedAt=now();a.usedMs+=Date.now()-started;
      if(controller.signal.aborted){a.state='interrupted';a.error='请求已取消；结果仅作历史保留';}
      else if(a.input.materialHash ? this.materialHash(s,discoverSource(this.project(id)))===a.input.materialHash : s.generation===a.input.generation && this.input(s).inputHash===a.input.inputHash){s.generation++;const view=projectView(a,s);s.views.push(view);s.currentView=s.views.length-1;a.promoted=true;if(result.scenarios?.length&&a.input.goal){const base={id:`scenarios-${randomUUID()}`,goalHash:a.input.goal.hash,goalVersion:a.input.goal.version,sourceHash:a.input.source.hash,analysisAttemptId:aid,scenarios:result.scenarios,status:'proposed' as const,author:'model',createdAt:now(),roundId:null};(s.scenarioSets??=[]).push({...base,hash:hash(base)});}}
      else a.error='STALE_RESULT：旧结果只进入历史，未覆盖当前目标';this.store.save(s);
    } catch(e) {s=this.read(id);const a=s.attempts.find(a=>a.id===aid)!;a.state=controller.signal.aborted?'interrupted':'failed';a.error=e instanceof WorkflowError?`${e.code}: ${e.message}`:String(e);a.endedAt=now();a.usedMs+=Date.now()-started;this.store.save(s);}finally{this.controllers.delete(aid);this.finishRoundAnalysis(id,aid);}
  }
  cancel(id:string,aid:string){const s=this.read(id),pending=s.roundAnalysis?.jobs.find(j=>j.id===aid&&j.state==='pending');if(pending){pending.state='cancelled';pending.error='用户取消待分析请求';pending.endedAt=now();this.store.save(s);return {attemptId:aid};}const a=s.attempts.find(a=>a.id===aid);if(!a)throw new WorkflowError('REFERENCE_UNRESOLVED','任务不存在');if(a.state==='queued'){a.state='interrupted';a.error='用户取消排队任务';a.endedAt=now();this.store.save(s);this.finishRoundAnalysis(id,aid);}this.controllers.get(aid)?.abort();return {attemptId:aid};}
  closedLoop(id:string){const s=this.read(id),source=discoverSource(this.project(id));return projectClosedLoop(s,source.hash,s.currentView!==null&&this.viewIsCurrent(s,s.views[s.currentView]));}
  annotateMainline(id:string,raw:unknown){const s=this.read(id),source=discoverSource(this.project(id)),revision=s.mainlineAnnotations?.revision??0;const annotation=appendMainlineAnnotation(s,raw,source.hash);if(s.mainlineAnnotations!.revision!==revision)this.store.save(s);return {annotationId:annotation.id,revision:s.mainlineAnnotations!.revision};}
  verificationContext(id:string,roundId:string){return verificationContext(this.read(id),this.project(id),roundId);}
  reviewScenarios(id:string,raw:unknown):unknown {
    const req=z.object({expectedGeneration:z.number().int().nonnegative(),idempotencyKey:safeId,proposalId:safeId,decision:z.enum(['confirm','reject']),author:text,roundId:safeId.nullable(),scenarios:scenarioListSchema,analyze:z.boolean().default(true)}).strict().parse(raw),s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);
    const proposal=s.scenarioSets?.find(x=>x.id===req.proposalId),goal=s.goals.at(-1),view=s.currentView===null?null:s.views[s.currentView],source=discoverSource(this.project(id));
    if(!proposal||!['proposed','confirmed'].includes(proposal.status)||!goal||proposal.goalHash!==goal.hash||!view||view.goal?.hash!==goal.hash||view.source.hash!==source.hash||(proposal.status==='proposed'&&(proposal.analysisAttemptId!==view.attemptId||proposal.sourceHash!==source.hash))||(proposal.status==='confirmed'&&activeConfirmation(s)?.id!==proposal.id))throw new WorkflowError('STALE_PROPOSAL','场景提议已过期，请按当前目标与来源重分析',409);
    if(req.decision==='confirm'&&!req.scenarios.length)throw new WorkflowError('SCENARIO_REQUIRED','确认集不能为空');
    validateScenarios(req.scenarios,view.analysis,goal);
    if(req.roundId&&!s.rounds?.registrations.some(r=>r.binding.roundId===req.roundId&&r.binding.goalHash===goal.hash))throw new WorkflowError('ROUND_REQUIRED','确认须关联当前目标的登记轮次');
    const base={id:`scenarios-${randomUUID()}`,goalHash:goal.hash,goalVersion:goal.version,sourceHash:source.hash,analysisAttemptId:view.attemptId,scenarios:req.scenarios,status:req.decision==='confirm'?'confirmed' as const:'rejected' as const,proposalId:proposal.id,author:req.author,createdAt:now(),roundId:req.roundId};
    (s.scenarioSets??=[]).push({...base,hash:hash(base)});s.generation++;const result={scenarioSetId:base.id,generation:s.generation,status:base.status};this.remember(s,req.idempotencyKey,req,result);
    if(req.analyze){try{const job=this.analyze(id,{expectedGeneration:s.generation,idempotencyKey:`analysis-${base.id}`});const response={...result,job};this.remember(this.read(id),req.idempotencyKey,req,response);return response;}catch(e){const response={...result,analysisError:String(e)};this.remember(this.read(id),req.idempotencyKey,req,response);return response;}}return result;
  }
  importVerification(id:string,raw:unknown):unknown {
    const req=z.object({expectedGeneration:z.number().int().nonnegative(),idempotencyKey:safeId,record:recordRef,analyze:z.boolean().optional()}).strict().parse(raw),s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);
    const path=evidenceFile(this.project(id),req.record);if(lstatSync(path).size>2000000)throw new WorkflowError('RECORD_LIMIT','回执超过导入大小限制');const bytes=readFileSync(path);if(digest(bytes)!==req.record.sha256)throw new WorkflowError('EVIDENCE_HASH','回执文件 hash 不符');
    const receipt=validateReceipt(JSON.parse(bytes.toString()),s,this.project(id),this.config),old=s.verificationReceipts?.find(r=>r.id===receipt.id);
    if(old&&old.hash!==receipt.hash)throw new WorkflowError('IDEMPOTENCY_CONFLICT','不可覆盖同 ID 的回执',409);
    if(!old){(s.verificationReceipts??=[]).push(receipt);s.generation++;}
    const result={receiptId:receipt.id,generation:s.generation,sourceChanged:receipt.sourceChanged,status:'imported',duplicate:!!old,analysisRequired:!old};
    this.remember(s,req.idempotencyKey,req,result);
    if(!old&&req.analyze!==false){try{const job=this.analyze(id,{expectedGeneration:s.generation,idempotencyKey:`analysis-${receipt.id}`});return this.remember(this.read(id),req.idempotencyKey,req,{...result,job});}catch(e){return this.remember(this.read(id),req.idempotencyKey,req,{...result,analysisError:String(e)});}}
    return result;
  }
  importRoundEvidence(id:string,raw:unknown):unknown {
    const ref=recordRef.parse(raw),path=evidenceFile(this.project(id),ref);
    if(lstatSync(path).size>100000)throw new WorkflowError('RECORD_LIMIT','证据过大');
    const bytes=readFileSync(path,'utf8');
    if(Buffer.byteLength(bytes)>100000||digest(bytes)!==ref.sha256)throw new WorkflowError('EVIDENCE_HASH','证据大小或 hash 不符');
    const record=JSON.parse(bytes),s=this.read(id),key=`round-evidence-${ref.sha256.slice(0,40)}`;
    let expectedGeneration=s.generation;
    const previous=s.idempotency[key];
    if(previous){
      // observe increments generation exactly once before storing this receipt. Rebuild
      // its original request precondition, including for legacy saved imports. The full
      // payload hash below still binds the raw bytes, trusted reference and proof scope.
      const receipt=z.object({observationId:safeId,generation:z.number().int().positive()}).safeParse(previous.result);
      if(!receipt.success||!s.observations.some(o=>o.id===receipt.data.observationId))throw new WorkflowError('IDEMPOTENCY_CONFLICT','请求键未绑定有效观察回执',409);
      expectedGeneration=receipt.data.generation-1;
    }
    // Replays return the original historical observation before current-source qualification;
    // fresh writes retain observe's CAS. Trusted file/hash validation above runs on every call.
    return this.observe(id,{expectedGeneration,idempotencyKey:key,producer:record.producer,rawRecord:bytes,rawHash:ref.sha256,sourceHash:record.sourceHash,goalHash:record.goalHash,targetIds:record.targetIds,clauseIds:record.clauseIds,result:record.result,trustedRecord:{rootIndex:ref.rootIndex,path:ref.path}});
  }
  observe(id:string,raw:unknown):unknown {
    const req=z.object({expectedGeneration:z.number().int(),idempotencyKey:safeId,producer:text,rawRecord:z.string().min(1).max(100000),rawHash:z.string().regex(/^[a-f0-9]{64}$/),sourceHash:text,goalHash:text,targetIds:z.array(safeId).min(1),clauseIds:z.array(safeId).min(1),result:z.enum(['passed','failed','unknown']),trustedRecord:z.object({rootIndex:z.number().int().nonnegative(),path:text}).optional()}).strict().parse(raw);
    const s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);if(digest(req.rawRecord)!==req.rawHash)throw new WorkflowError('EVIDENCE_UNQUALIFIED','原始记录 hash 不符');
    let qualified=false,qualificationReason='仅导入原件：未匹配已登记执行记录，不授予绿色状态',invocation:unknown=null;
    if(req.trustedRecord){const root=this.project(id).evidenceRoots?.[req.trustedRecord.rootIndex];if(!root)throw new WorkflowError('EVIDENCE_UNQUALIFIED','未登记的证据来源');const bytes=readFileSync(safePath(root,req.trustedRecord.path),'utf8');const record=JSON.parse(bytes);invocation=record.invocation??null;
      const source=discoverSource(this.project(id));const goal=s.goals.at(-1);const hasExecution=record.invocation?.kind==='shell'&&Array.isArray(record.invocation.argv)&&record.invocation.argv.length>0&&typeof record.invocation.stdout==='string'&&typeof record.invocation.stderr==='string'&&Number.isInteger(record.invocation.exitCode);
      qualified=digest(bytes)===req.rawHash&&record.schema==='project-os.scoped-observation.v1'&&record.producer===req.producer&&record.sourceHash===req.sourceHash&&source.hash===req.sourceHash&&goal?.hash===req.goalHash&&record.goalHash===req.goalHash&&hash(record.targetIds)===hash(req.targetIds)&&hash(record.clauseIds)===hash(req.clauseIds)&&record.result===req.result&&record.behaviorScope===true&&hasExecution&&(req.result==='passed'?record.invocation.exitCode===0:record.invocation.exitCode!==0);
      qualificationReason=qualified?'匹配已登记执行原件、来源、目标、节点或边及行为范围；仅对该范围有效':'记录或执行范围不满足资格，保留原件但不升级';
    }
    const view=s.currentView===null?null:s.views[s.currentView];if(req.targetIds.some(t=>!view?.analysis.modules.some(m=>m.id===t)&&!view?.analysis.edges.some(e=>e.id===t))||req.clauseIds.some(c=>!s.goals.at(-1)?.clauses.some(x=>x.id===c)))throw new WorkflowError('REFERENCE_UNRESOLVED','观察的对象或目标不存在');
    // Only explicit metadata in the hash-bound raw record is projected. Never infer it from argv/output.
    let metadata:{scopeSummary?:string;limitations?:string[];roundIds?:string[]}={};let record:unknown;
    try{record=JSON.parse(req.rawRecord);}catch{/* Legacy free-text evidence has no declared scope summary. */}
    if(record&&typeof record==='object'&&(record as {schema?:string}).schema==='project-os.scoped-observation.v1'){
      const clean=(s:string)=>s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
      const summary=z.string().max(1600).transform(clean).refine(s=>s.length>0),limitation=z.string().max(400).transform(clean).refine(s=>s.length>0);
      metadata=z.object({scopeSummary:summary.optional(),limitations:z.array(limitation).max(12).optional(),roundIds:z.array(safeId).min(1).max(100).refine(ids=>new Set(ids).size===ids.length).optional()}).parse(record);
      if(metadata.roundIds?.some(id=>!s.rounds?.registrations.some(r=>r.binding.roundId===id&&r.binding.goalHash===req.goalHash)))throw new WorkflowError('REFERENCE_UNRESOLVED','观察引用的轮次或轮次目标不存在');
    }
    const o:Observation={...(metadata.roundIds?{roundIds:metadata.roundIds}:{}),scopeSummary:metadata.scopeSummary??null,limitations:metadata.limitations??null,id:`observation-${randomUUID()}`,sourceHash:req.sourceHash,goalHash:req.goalHash,producer:req.producer,targetIds:req.targetIds,clauseIds:req.clauseIds,rawRecord:req.rawRecord,rawHash:req.rawHash,result:req.result,qualified,qualificationReason,invocation,createdAt:now()};s.observations.push(o);s.generation++;const result=this.remember(s,req.idempotencyKey,req,{observationId:o.id,qualified,qualificationReason,generation:s.generation});this.reconcileRoundAnalysis(id);return result;
  }
  action(id:string,raw:unknown){const req=z.object({expectedGeneration:z.number().int(),idempotencyKey:safeId,gapId:safeId}).strict().parse(raw),s=this.read(id),prior=this.replay(s,req.idempotencyKey,req);if(prior!==undefined)return prior;this.cas(s,req.expectedGeneration,req);const view=s.currentView===null?null:s.views[s.currentView],gap=view?.gaps.find(g=>g.id===req.gapId);if(!gap)throw new WorkflowError('REFERENCE_UNRESOLVED','建议不存在');const action={id:`action-${randomUUID()}`,gapId:req.gapId,generation:s.generation,createdAt:now()};s.actions.push(action);return this.remember(s,req.idempotencyKey,req,{...action,prerequisites:gap.prerequisites,verificationPlan:gap.verificationPlan,execution:'not_run'});}
  async idle(){let pending;do{pending=this.queue;await pending;}while(pending!==this.queue);}
  async close(){this.follower.stop();this.activity.stop();this.closing=true;for(const c of this.controllers.values())c.abort();await this.queue;this.store.close();}
}
const level={ 'hard-constraint':0,core:1,supporting:2,optional:3 };
export function targetStatus(view:View,observations:Observation[],targetId:string,clauseId?:string,notBefore?:string):string {
  const relevant=observations.filter(o=>o.qualified&&(!notBefore||Date.parse(o.createdAt)>=Date.parse(notBefore))&&o.sourceHash===view.source.hash&&o.goalHash===view.goal?.hash&&o.targetIds.includes(targetId)&&(!clauseId||o.clauseIds.includes(clauseId)));
  if(relevant.some(o=>o.result==='failed'))return 'verified-mismatch';
  const clauses=clauseId?[clauseId]:view.analysis.alignments.filter(a=>a.targetIds.includes(targetId)).flatMap(a=>a.clauseIds);
  if(clauses.length&&clauses.every(c=>relevant.some(o=>o.result==='passed'&&o.clauseIds.includes(c))))return 'verified-aligned';
  if(view.analysis.modules.some(m=>m.id===targetId&&m.kind==='proposed'))return 'unknown';
  return view.analysis.alignments.find(a=>a.targetIds.includes(targetId)&&(!clauseId||a.clauseIds.includes(clauseId)))?.status??'unknown';
}
export function projectView(attempt:Attempt,s:Session):View {
  const a=attempt.result!,input=attempt.input,previous=s.currentView===null?null:s.views[s.currentView];
  const gaps:GapView[]=a.gaps.map(g=>({...g,lifecycle:'open',rankReason:'',rank:0}));
  const priority=(g:GapView)=>Math.min(...g.clauseIds.map(id=>level[input.goal?.clauses.find(c=>c.id===id)?.importance??'optional']));
  const info=(g:GapView)=>['investigate','add-evidence'].includes(g.actionKind)?0:1;
  gaps.sort((x,y)=>priority(x)-priority(y)||new Set(y.unblocksClauseIds).size-new Set(x.unblocksClauseIds).size||info(x)-info(y)||(x.effort==='small'?0:1)-(y.effort==='small'?0:1)||(x.risk==='low'?0:1)-(y.risk==='low'?0:1)||x.id.localeCompare(y.id));
  for(const [i,g] of gaps.entries()){g.rank=i+1;g.rankReason=`${input.goal?.clauses.filter(c=>g.clauseIds.includes(c.id)).map(c=>`${c.text}（${c.importance}）`).join('；')}；解除 ${new Set(g.unblocksClauseIds).size} 项条款依赖（分析假设）；${info(g)===0?'先补判别证据':'比较修复前提'}；工作量 ${g.effort}，风险 ${g.risk}；同级按稳定 ID 显示，未知不视作已测量成本`;}
  for(const old of previous?.gaps??[])if(!gaps.some(g=>g.id===old.id)){
    const removed=old.clauseIds.some(id=>!input.goal?.clauses.some(c=>c.id===id));
    const changedGoal=old.clauseIds.some(id=>{const before=previous?.goal?.clauses.find(c=>c.id===id),after=input.goal?.clauses.find(c=>c.id===id);return before&&after&&hash(before)!==hash(after);});
    const correction=a.changes.find(c=>c.gapId===old.id&&c.disposition==='retracted');
    const resolved=previous?.source.hash!==input.source.hash&&old.targetIds.every(t=>old.clauseIds.every(c=>s.observations.some(o=>o.qualified&&(!s.rounds?.snapshots.length||Date.parse(o.createdAt)>=Date.parse(s.rounds.snapshots.at(-1)!.observedAt??s.rounds.snapshots.at(-1)!.importedAt))&&o.result==='passed'&&o.sourceHash===input.source.hash&&o.goalHash===input.goal?.hash&&o.targetIds.includes(t)&&o.clauseIds.includes(c))));
    const lifecycle=removed||changedGoal?'scope-changed':correction?'retracted':resolved?'resolved':'stale';
    gaps.push({...old,lifecycle,closureReason:lifecycle==='scope-changed'?'目标范围变化，不是功能修复':lifecycle==='retracted'?correction!.reason:lifecycle==='resolved'?'源码变化及当前条款/对象行为验证合格':'本次未重新定位旧差距；不能推断已解决'});
  }
  return {generation:s.generation,attemptId:attempt.id,source:input.source,goal:input.goal,analysis:a,gaps,createdAt:now(),status:attempt.state==='partial'?'partial':'completed',changes:{goal:previous?.goal?.hash===input.goal?.hash?'目标未变化':'人类目标版本已变化；不代表代码修复',interpretation:previous?.analysis.purpose===a.purpose?'用途说明未变；比较各模块、连接及 feedbackResponse':`此前：${previous?.analysis.purpose??'无'}\n本次：${a.purpose}`,source:previous?.source.hash===input.source.hash?'源字节未变；本次重新读取所供片段':'来源绑定已变化或首次分析',ranking:`此前：${previous?.gaps.filter(g=>g.lifecycle==='open').map(g=>g.id).join(' → ')??'无'}\n本次：${gaps.filter(g=>g.lifecycle==='open').map(g=>g.id).join(' → ')}\n排序依据当前条款重要性、依赖解除与判别价值；详见每项理由`,evidence:`保留 ${s.observations.length} 条原始观察；模型输出不产生运行通过`}};
}
