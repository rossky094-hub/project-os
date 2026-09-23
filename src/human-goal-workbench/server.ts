import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HumanGoalService, targetStatus } from '../core/human-goal-workflow/service.js';
import { WorkflowError, digest, hash } from '../core/human-goal-workflow/types.js';
import { projectRounds, diagnosisState, snapshotRequestSchema, registrationRequestSchema } from '../core/human-goal-workflow/rounds.js';
import { readSource } from '../core/human-goal-workflow/source.js';
import { projectActivity } from '../core/human-goal-workflow/agent-activity.js';
import { projectMainlineProgress } from '../core/human-goal-workflow/mainline-progress.js';
const assets = new Map([['/',['index.html','text/html; charset=utf-8']],['/client.js',['client.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']]]);
async function body(req:IncomingMessage):Promise<unknown>{let bytes=0;const chunks:Buffer[]=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>128000)throw new WorkflowError('BODY_LIMIT','请求过大',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new WorkflowError('JSON_INVALID','请求须为 JSON');}}
export async function startServer(service:HumanGoalService,port=service.config.port){
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const address=server.address();const actual=typeof address==='object'&&address?address.port:port;const allowed=`127.0.0.1:${actual}`;
      if(req.headers.host!==allowed)throw new WorkflowError('HOST_REFUSED','只接受该 loopback 地址',403);
      const url=new URL(req.url??'/',`http://${allowed}`);
      if(req.method!=='GET'&&req.method!=='POST')throw new WorkflowError('METHOD_REFUSED','不支持此方法',405);
      if(req.method==='POST'&&(req.headers.origin!==`http://${allowed}`||!req.headers['content-type']?.startsWith('application/json')||req.headers['sec-fetch-site']==='cross-site'))throw new WorkflowError('ORIGIN_REFUSED','写入需要同源 JSON 请求',403);
      const asset=assets.get(url.pathname);if(asset&&req.method==='GET'){res.setHeader('Content-Type',asset[1]);res.end(readFileSync(new URL(asset[0],import.meta.url)));return;}
      let result:unknown;
      if(url.pathname==='/api/projects'&&req.method==='GET')result={projects:service.config.projects.map(({id,label,revision,sourceKind,sourceRoot,scope,subjectId,caseRole,evidenceRoots})=>({id,label,revision,sourceKind,sourceRoot,scope,subjectId,caseRole,evidenceRootIndices:(evidenceRoots??[]).map((_,i)=>i)})),artifactVersion:'0.6.0-candidate',analyzer:'configured Codex CLI'};
      else {
        const match=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9._-]+)\/(state|history|source|feedback|analyze|retry|cancel|observations|actions|rounds|round-enroll|round-events|round-replay|round-snapshot|round-checkpoint|round-evidence|scenario-review|verification-context|verification-import|closed-loop|activity|activity-connect|activity-replay|mainline-annotate)$/);if(!match)throw new WorkflowError('NOT_FOUND','接口不存在',404);
        const [,id,op]=match;service.project(id);
        if(req.method==='GET'){
          const s=service.read(id);
          if(op==='closed-loop')result=service.closedLoop(id);
          else if(op==='activity'){const sourceHash=service.closedLoop(id).sourceHash,rounds=projectRounds(s,service.config.roundPolicy,sourceHash),mainline=projectMainlineProgress(s,sourceHash,rounds);result={...projectActivity(s,sourceHash,mainline),mainline};}
          else if(op==='verification-context')result=service.verificationContext(id,url.searchParams.get('roundId')??'');
          else if(op==='rounds')result={...projectRounds(s,service.config.roundPolicy,service.closedLoop(id).sourceHash),eventReadPolicy:service.config.eventReadPolicy,analysisPolicy:service.config.roundAnalysis,analysisJobs:s.roundAnalysis?.jobs??[]};
          else if(op==='state'||op==='history'){
            // Source/request bodies are retained on disk, not multiplied into every polling response.
            const closedLoop=service.closedLoop(id),rounds={...projectRounds(s,service.config.roundPolicy,closedLoop.sourceHash),eventReadPolicy:service.config.eventReadPolicy},mainline=projectMainlineProgress(s,closedLoop.sourceHash,rounds);
            const views=s.views.map(v=>({...v,source:{...v.source,files:v.source.files.map(({excerpt,...f})=>f)},statuses:Object.fromEntries([...v.analysis.modules,...v.analysis.edges].map(t=>[t.id,op==='state'&&s.views[s.currentView??-1]?.attemptId===v.attemptId&&(closedLoop.diagnosisStale||!service.viewIsCurrent(s,v))?'stale':targetStatus(v,s.observations,t.id,undefined,op==='state'?(rounds.rounds.find(r=>r.viewAttemptId===v.attemptId)?.after?.observedAt??s.rounds?.snapshots.at(-1)?.observedAt??undefined):undefined)]))}));
            result={...s,agentActivity:undefined,mainlineAnnotations:undefined,activity:projectActivity(s,closedLoop.sourceHash,mainline),mainline,closedLoop,conflicts:s.conflicts.map(c=>({...c,request:c.request&&typeof c.request==='object'&&'rawRecord' in c.request?{requestHash:hash(c.request),original:'retained locally'}:c.request})),rounds,roundViews:views.filter(v=>rounds.rounds.some(r=>r.viewAttemptId===v.attemptId)),diagnosisStatus:s.currentView!==null&&(closedLoop.diagnosisStale||!service.viewIsCurrent(s,s.views[s.currentView]))?'stale':diagnosisState(s.currentView===null?null:s.views[s.currentView],s.goals.at(-1)?.hash),roundAnalysisPolicy:service.config.roundAnalysis,views:op==='history'?views:views.filter((_,i)=>i===s.currentView),currentView:op==='history'?s.currentView:(s.currentView===null?null:0),attempts:s.attempts.map(({input,result,...a})=>({...a,inputHash:input.inputHash,goalVersion:input.goal?.version??null,sourceHash:input.source.hash,plan:input.plan,resultAvailable:!!result})),observations:s.observations.map(({rawRecord,invocation,...o})=>o),idempotency:undefined};
          } else if(op==='source'){
            const path=url.searchParams.get('path')??'',raw=readSource(service.project(id),path),expected=url.searchParams.get('sha256');if(expected&&digest(raw)!==expected)throw new WorkflowError('REVISION_MISMATCH','当前源文件与分析引用不符',409);
            const start=Math.max(1,Number(url.searchParams.get('start')??1)),end=Math.min(start+199,Number(url.searchParams.get('end')??start+100));if(!Number.isInteger(start)||!Number.isInteger(end)||end<start)throw new WorkflowError('SOURCE_RANGE','行号无效');result={path,sha256:digest(raw),start,end,text:raw.split('\n').slice(start-1,end).map((line,i)=>`${i+start}: ${line}`).join('\n')};
          } else throw new WorkflowError('METHOD_REFUSED','此操作需要 POST',405);
        } else {const b=await body(req);switch(op){case'activity-connect':result=service.activity.connect(id,b);break;case'activity-replay':{const connectionId=(b as {connectionId?:unknown})?.connectionId;if(typeof connectionId!=='string')throw new WorkflowError('REQUEST_INVALID','缺 connectionId');result=service.activity.replay(id,connectionId);break;}case'mainline-annotate':result=service.annotateMainline(id,b);break;case'scenario-review':result=service.reviewScenarios(id,b);break;case'verification-import':result=service.importVerification(id,b);break;case'round-enroll':result=service.rounds.enroll(id,b);break;case'round-events':result=service.rounds.accept(id,b);break;case'round-replay':{const {registrationId:r}=registrationRequestSchema.parse(b);result=service.follower.follow(id,r);break;}case'round-snapshot':{const request=snapshotRequestSchema.parse(b);result=request.import?service.rounds.importSnapshot(id,request.import):service.rounds.capture(id);break;}case'round-checkpoint':{const {registrationId:r}=registrationRequestSchema.parse(b);result=service.rounds.checkpoint(id,r);break;}case'round-evidence':result=service.importRoundEvidence(id,b);break;case'feedback':result=service.feedback(id,b);break;case'analyze':result=service.analyze(id,b);break;case'retry':result=service.retry(id,b);break;case'observations':result=service.observe(id,b);break;case'actions':result=service.action(id,b);break;case'cancel':{const aid=(b as {attemptId?:unknown})?.attemptId;if(typeof aid!=='string')throw new WorkflowError('REQUEST_INVALID','缺 attemptId');result=service.cancel(id,aid);break;}default:throw new WorkflowError('METHOD_REFUSED','此操作仅支持读取',405);}}
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
    }catch(e){const error=e instanceof WorkflowError?e:new WorkflowError('REQUEST_FAILED',e instanceof Error?e.message:String(e));res.statusCode=error.status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({code:error.code,message:error.message,details:error.details}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();const actual=typeof address==='object'&&address?address.port:port;
  const endpoint=join(service.store.root,'server-endpoint.json');writeFileSync(endpoint,JSON.stringify({url:`http://127.0.0.1:${actual}`,pid:process.pid}),{mode:0o600});
  service.follower.start();
  service.activity.start();
  return {server,url:`http://127.0.0.1:${actual}`,close:async()=>{service.follower.stop();service.activity.stop();try{unlinkSync(endpoint);}catch{}await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await service.close();}};
}
