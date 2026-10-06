import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]),endpoint=JSON.parse(readFileSync(join(root,'internal/runtime/server-endpoint.json'),'utf8')).url.replace(/\/$/,'');
const response=await fetch(endpoint+'/api/projects/project-os-demo/state');
if(!response.ok)throw new Error('State read failed: '+response.status);
const state=await response.json(),round=state.rounds.rounds.find(r=>r.id==='round-launch-readme-20261006');
const before=JSON.parse(readFileSync(join(root,'internal/round-before.json'),'utf8')),
 after=JSON.parse(readFileSync(join(root,'internal/round-after.json'),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
const beforeReadme=before.inventory.find(f=>f.path==='README.md'),afterReadme=after.inventory.find(f=>f.path==='README.md');
const observed=state.views[state.currentView],checks={
 registration:!!round&&round.goalHash===state.goals.at(-1).hash,
 boundaries:round?.before?.id===before.id&&round?.after?.id===after.id,
 completed:round?.status==='completed'&&round.observedBegin===true,
 actualBefore:sha(readFileSync(join(root,'internal/readme-before.md')))===beforeReadme?.sha256,
 actualAfter:sha(readFileSync(join(root,'working/project-os/README.md')))===afterReadme?.sha256,
 onlyReadme:round?.deltas?.length===1&&round.deltas[0].path==='README.md'&&round.deltas[0].kind==='modified',
 currentSource:observed?.source.hash===after.sourceHash&&observed.goal.hash===state.goals.at(-1).hash,
 manual:round?.attempts?.some(a=>a.toolVersion==='manual-delegated-events')||state.rounds.registrations.some(r=>r.id==='registration-launch-readme-20261006'&&r.toolVersion==='manual-delegated-events')
};
const passed=Object.values(checks).every(Boolean);
const evidence={schema:'project-os.launch-round-check.v1',at:new Date().toISOString(),scope:'README material round registration, actual before/after bytes, manual events and source binding; not novice comprehension or core product capability.',goalHash:state.goals.at(-1).hash,sourceHash:after.sourceHash,roundId:round?.id,checks};
writeFileSync(join(root,'internal/launch-round-check-details.json'),JSON.stringify(evidence,null,2)+'\n');
console.log('PROJECT_OS_ASSERTION '+JSON.stringify({assertionId:'launch-round-purpose',status:passed?'passed':'behavior-failed',actual:passed?'本轮README改稿的目的、目标绑定、前后实际来源及手工事件均可核查':'轮次或来源核对不符',evidence:JSON.stringify(evidence)}));
console.log('PROJECT_OS_ASSERTION '+JSON.stringify({assertionId:'launch-independent-reader',status:'unknown',actual:'本次未组织独立新手参与者作答；操作者、模型和软件检查不能替代',evidence:'No independent participant response was collected in this recorded self-case.'}));
if(!passed)process.exitCode=1;
