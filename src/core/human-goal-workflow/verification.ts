import { spawn } from 'node:child_process';
import { existsSync, lstatSync, accessSync, constants } from 'node:fs';
import { isAbsolute, resolve, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { discoverSource, safePath } from './source.js';
import { activeConfirmation, validateScenarios } from './scenarios.js';
import { hash, safeId, text, WorkflowError, type Config, type Project, type Session } from './types.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const assertionStatus=z.enum(['passed','environment-blocked','missing-capability','behavior-failed','unknown']);
const assertionSchema=z.object({assertionId:safeId,status:assertionStatus,actual:text,evidence:text}).strict();
const traceSchema=z.object({id:safeId,from:safeId,to:safeId,edgeId:safeId,traceId:text,event:text,evidence:text}).strict();
export const receiptSchema=z.object({schema:z.literal('project-os.verification.v1'),id:safeId,binding:z.object({projectId:safeId,registryHash:sha,sourceHash:sha,goalHash:sha,goalVersion:z.number().int().positive(),confirmationId:safeId,confirmationHash:sha,roundId:safeId,roundBindingHash:sha,beforeSnapshotId:safeId,taskPurpose:text,criteria:z.array(z.object({scenarioId:safeId,criterionId:safeId,criterionHash:sha}).strict())}).strict(),startedAt:z.string().datetime(),endedAt:z.string().datetime(),sourceAfterHash:sha,sourceChanged:z.boolean(),checks:z.array(z.object({id:safeId,configHash:sha,argv:z.array(text).min(1),cwd:text,startedAt:z.string().datetime(),endedAt:z.string().datetime(),preflight:z.array(z.object({kind:text,value:text,passed:z.boolean(),reason:text}).strict()),exitCode:z.number().int().nullable(),signal:z.string().nullable(),stdout:z.string().max(1000000),stderr:z.string().max(1000000),executionError:z.string().nullable(),assertions:z.array(assertionSchema.extend({scenarioId:safeId,criterionId:safeId,criterionHash:sha})).max(200),traces:z.array(traceSchema).max(500)}).strict()).min(1).max(100),hash:sha}).strict();
export type VerificationReceipt=z.infer<typeof receiptSchema>;
export function verificationContext(s:Session,p:Project,roundId:string){
 const confirmation=activeConfirmation(s),goal=s.goals.at(-1),source=discoverSource(p),view=s.currentView===null?null:s.views[s.currentView];
 if(!confirmation||!goal)throw new WorkflowError('CONFIRMATION_REQUIRED','请先确认当前目标的场景与条件',409);
 if(!view||view.source.hash!==source.hash||view.goal?.hash!==goal.hash)throw new WorkflowError('SOURCE_STALE','请重新分析当前来源再执行条件验证',409);
 validateScenarios(confirmation.scenarios,view.analysis,goal);
 const registration=s.rounds?.registrations.filter(r=>r.binding.roundId===roundId).at(-1);
 if(!registration||registration.binding.goalHash!==goal.hash)throw new WorkflowError('ROUND_REQUIRED','验证须绑定登记的当前目标轮次',409);
 if(confirmation.roundId&&confirmation.roundId!==roundId)throw new WorkflowError('ROUND_MISMATCH','场景确认绑定另一轮次',409);
 return {binding:{projectId:p.id,registryHash:s.registryHash,sourceHash:source.hash,goalHash:goal.hash,goalVersion:goal.version,confirmationId:confirmation.id,confirmationHash:confirmation.hash,roundId,roundBindingHash:registration.bindingHash,beforeSnapshotId:registration.binding.beforeSnapshotId,taskPurpose:registration.binding.purpose,criteria:confirmation.scenarios.flatMap(sc=>sc.criteria.map(c=>({scenarioId:sc.id,criterionId:c.id,criterionHash:hash(c)})))},edges:view.analysis.edges.map(e=>({id:e.id,from:e.from,to:e.to}))};
}
export type VerificationContext=ReturnType<typeof verificationContext>;
function executableAvailable(command:string,cwd:string){const candidates=isAbsolute(command)?[command]:command.includes('/')?[resolve(cwd,command)]:(process.env.PATH??'').split(delimiter).filter(Boolean).map(p=>resolve(p,command));return candidates.some(p=>{try{accessSync(p,constants.X_OK);return lstatSync(p).isFile()||lstatSync(p).isSymbolicLink();}catch{return false;}});}
function parseOutput(stdout:string,exitCode:number|null,error:string|null,bindings:z.infer<typeof ConfigCheck>['bindings'],context:VerificationContext){
 const raw: z.infer<typeof assertionSchema>[]=[],traces:z.infer<typeof traceSchema>[]=[];let malformed=false;
 for(const line of stdout.split('\n')){try{if(line.startsWith('PROJECT_OS_ASSERTION '))raw.push(assertionSchema.parse(JSON.parse(line.slice(21))));if(line.startsWith('PROJECT_OS_TRACE '))traces.push(traceSchema.parse(JSON.parse(line.slice(17))));}catch{malformed=true;}}
 const assertions=bindings.map(b=>{const bound=context.binding.criteria.find(c=>c.scenarioId===b.scenarioId&&c.criterionId===b.criterionId)!;const matches=raw.filter(a=>a.assertionId===b.assertionId),a=matches.length===1?matches[0]:null;
  const admitted=a&&!malformed&&!error&&!(a.status==='passed'&&exitCode!==0);
  return {...bound,assertionId:b.assertionId,status:admitted?a.status:'unknown' as const,actual:admitted?a.actual:'未取得唯一、有效的条件断言',evidence:admitted?a.evidence:error??`exit=${exitCode}; 进程退出不等于条件通过`};
 });
 const validTraces=!malformed&&!error?traces.filter(t=>context.edges.some(e=>e.id===t.edgeId&&e.from===t.from&&e.to===t.to)):[];
 return {assertions,traces:validTraces};
}
// Only config-owned argv enters spawn. Browser and model requests never supply commands.
import { registeredCheckSchema as ConfigCheck } from './types.js';
export async function runVerification(config:Config,p:Project,context:VerificationContext,checkIds:string[],signal?:AbortSignal):Promise<VerificationReceipt>{
 const registry=config.verificationChecks[p.id]??[];
 if(!checkIds.length||new Set(checkIds).size!==checkIds.length)throw new WorkflowError('CHECK_REQUIRED','显式选择互不重复的登记检查');
 const checks=checkIds.map(id=>{const c=registry.find(c=>c.id===id);if(!c)throw new WorkflowError('CHECK_UNKNOWN','检查未登记');if(new Set(c.bindings.map(b=>b.assertionId)).size!==c.bindings.length||c.bindings.some(b=>!context.binding.criteria.some(x=>x.scenarioId===b.scenarioId&&x.criterionId===b.criterionId)))throw new WorkflowError('CRITERION_UNKNOWN','检查条件映射不存在或断言重复');return c;});
 if(context.binding.projectId!==p.id||context.binding.registryHash!==hash(p)||discoverSource(p).hash!==context.binding.sourceHash)throw new WorkflowError('SOURCE_STALE','执行前来源或登记已改变',409);
 const metadata=()=>hash(discoverSource(p).inventory.map(f=>{const st=lstatSync(safePath(p.sourceRoot,f.path));return [f.path,st.ino,st.size,st.mtimeMs,st.ctimeMs];})),initialMetadata=metadata();
 const startedAt=new Date().toISOString(),results:VerificationReceipt['checks']=[];let sourceChanged=false,totalOutput=0;
 const observe=()=>{try{if(discoverSource(p).hash!==context.binding.sourceHash||metadata()!==initialMetadata)sourceChanged=true;}catch{sourceChanged=true;}};
 const watch=setInterval(observe,100);watch.unref();
 try{for(const check of checks){const checkStart=new Date().toISOString();
  const preflight=[{kind:'executable',value:check.argv[0],passed:executableAvailable(check.argv[0],p.sourceRoot),reason:'登记的执行程序须存在且可执行'},...check.prerequisites.map(q=>{let passed=false;try{passed=q.kind==='env'?!!process.env[q.value]:existsSync(isAbsolute(q.value)?q.value:safePath(p.sourceRoot,q.value));}catch{}return {...q,passed,reason:passed?'可用':'登记环境前提缺失'};})];
  let stdout='',stderr='',exitCode:number|null=null,exitSignal:string|null=null,executionError:string|null=null;
  if(preflight.every(p=>p.passed)&&!signal?.aborted){await new Promise<void>(resolve=>{const child=spawn(check.argv[0],check.argv.slice(1),{cwd:p.sourceRoot,shell:false,stdio:['ignore','pipe','pipe']});let killTimer:NodeJS.Timeout|undefined;
   const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1500);};
   const abort=()=>{executionError='cancelled';stop();};signal?.addEventListener('abort',abort,{once:true});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   const collect=(b:string,stream:'stdout'|'stderr')=>{totalOutput+=Buffer.byteLength(b);if(totalOutput>900000){executionError='output-limit';stop();return;}if(stream==='stdout')stdout+=b.toString();else stderr+=b.toString();};
   child.stdout.on('data',b=>collect(b,'stdout'));child.stderr.on('data',b=>collect(b,'stderr'));
   child.once('error',e=>{executionError=String(e);});child.once('close',(code,sig)=>{exitCode=code;exitSignal=sig;signal?.removeEventListener('abort',abort);if(killTimer)clearTimeout(killTimer);resolve();});if(signal?.aborted)abort();
  });}else executionError=signal?.aborted?'cancelled':'environment preflight blocked';
  const parsed=parseOutput(stdout,exitCode,executionError,check.bindings,context);
  if(preflight.some(p=>!p.passed))for(const a of parsed.assertions){a.status='environment-blocked';a.actual='环境前提未满足，未执行行为检查';a.evidence=JSON.stringify(preflight);}
  results.push({id:check.id,configHash:hash(check),argv:check.argv,cwd:p.sourceRoot,startedAt:checkStart,endedAt:new Date().toISOString(),preflight,exitCode,signal:exitSignal,stdout,stderr,executionError,...parsed});observe();if(signal?.aborted)break;
 }}finally{clearInterval(watch);}
 const sourceAfterHash=discoverSource(p).hash;sourceChanged ||= sourceAfterHash!==context.binding.sourceHash;
 const base={schema:'project-os.verification.v1' as const,id:`verification-${randomUUID()}`,binding:context.binding,startedAt,endedAt:new Date().toISOString(),sourceAfterHash,sourceChanged,checks:results};return receiptSchema.parse({...base,hash:hash(base)});
}
export function validateReceipt(raw:unknown,s:Session,p:Project,config:Config):VerificationReceipt{
 const r=receiptSchema.parse(raw),{hash:claimed,...base}=r;if(hash(base)!==claimed)throw new WorkflowError('EVIDENCE_HASH','验证回执内容 hash 不符');
 const confirmation=s.scenarioSets?.find(c=>c.id===r.binding.confirmationId&&c.status==='confirmed'),goal=s.goals.find(g=>g.hash===r.binding.goalHash),registration=s.rounds?.registrations.find(x=>x.bindingHash===r.binding.roundBindingHash);
 if(r.binding.projectId!==p.id||r.binding.registryHash!==s.registryHash||!confirmation||confirmation.hash!==r.binding.confirmationHash||confirmation.goalHash!==goal?.hash||goal.version!==r.binding.goalVersion||!registration||registration.binding.roundId!==r.binding.roundId||registration.binding.goalHash!==goal.hash||registration.binding.beforeSnapshotId!==r.binding.beforeSnapshotId||registration.binding.purpose!==r.binding.taskPurpose||confirmation.roundId&&confirmation.roundId!==r.binding.roundId)throw new WorkflowError('EVIDENCE_BINDING','验证的目标、确认或轮次绑定不符');
 if(Date.parse(r.endedAt)<Date.parse(r.startedAt)||Date.parse(r.startedAt)<Date.parse(confirmation.createdAt)||Date.parse(r.startedAt)<Date.parse(registration.createdAt)||r.checks.some(c=>Date.parse(c.startedAt)<Date.parse(r.startedAt)||Date.parse(c.endedAt)<Date.parse(c.startedAt)||Date.parse(c.endedAt)>Date.parse(r.endedAt))||r.sourceAfterHash!==r.binding.sourceHash&&!r.sourceChanged)throw new WorkflowError('EVIDENCE_BINDING','回执时间或来源变化状态不一致');
 const criteria=confirmation.scenarios.flatMap(sc=>sc.criteria.map(c=>({scenarioId:sc.id,criterionId:c.id,criterionHash:hash(c)})));if(hash(criteria)!==hash(r.binding.criteria))throw new WorkflowError('EVIDENCE_BINDING','验证条件发生变化');
 const view=[...s.views].reverse().find(v=>v.source.hash===r.binding.sourceHash&&v.goal?.hash===goal.hash);if(!view)throw new WorkflowError('EVIDENCE_BINDING','验证缺少匹配来源分析');
 const context={binding:r.binding,edges:view.analysis.edges.map(e=>({id:e.id,from:e.from,to:e.to}))};
 if(new Set(r.checks.map(c=>c.id)).size!==r.checks.length)throw new WorkflowError('EVIDENCE_BINDING','检查重复');
 for(const c of r.checks){const configured=config.verificationChecks[p.id]?.find(x=>x.id===c.id);if(!configured||hash(configured)!==c.configHash||hash(c.argv)!==hash(configured.argv)||c.cwd!==p.sourceRoot||hash(c.preflight.map(({kind,value})=>({kind,value})))!==hash([{kind:'executable',value:configured.argv[0]},...configured.prerequisites]))throw new WorkflowError('CHECK_UNKNOWN','验证命令或前提不匹配当前登记');
  if(configured.bindings.some(b=>!criteria.some(x=>x.scenarioId===b.scenarioId&&x.criterionId===b.criterionId)))throw new WorkflowError('EVIDENCE_BINDING','未确认的条件');
  const expected=parseOutput(c.stdout,c.exitCode,c.executionError,configured.bindings,context);
  if(c.preflight.some(p=>!p.passed)){if(c.exitCode!==null||c.stdout||c.traces.length)throw new WorkflowError('EVIDENCE_BINDING','环境阻塞不能包含已执行结果');for(const a of expected.assertions){a.status='environment-blocked';a.actual='环境前提未满足，未执行行为检查';a.evidence=JSON.stringify(c.preflight);}}
  if(hash(expected.assertions)!==hash(c.assertions)||hash(expected.traces)!==hash(c.traces))throw new WorkflowError('EVIDENCE_BINDING','条件结果不匹配结构化执行原文');
 }
 return r;
}
