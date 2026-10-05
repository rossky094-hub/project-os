import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import { startServer } from '../../src/human-goal-workbench/server.js';
import type { AnalysisInput, Analysis } from '../../src/core/human-goal-workflow/types.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'hg-http-SYNTHETIC-'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function fixture(){const source=join(root,'source');await mkdir(source);await writeFile(join(source,'main.ts'),'export function main() { return "SYNTHETIC"; }\n');const config={projects:[{id:'test',label:'SYNTHETIC test repository',sourceRoot:source,scope:['.'],revision:'synthetic',sourceKind:'snapshot',subjectId:'synthetic',caseRole:'positive-subject'}],dataDir:join(root,'data'),port:0};const analyzer={revision:'synthetic-http-test',async analyze(input:AnalysisInput):Promise<Analysis>{const f=input.source.files[0];return {purpose:'SYNTHETIC </script><img src=x onerror="window.pwned=1">',purposeRefs:[{path:f.path,sha256:f.sha256,start:1,end:1}],limitations:['injected test'],modules:[{id:'module-main',title:'SYNTHETIC source',kind:'discovered',responsibility:'Read local source',inputs:[],outputs:[],refs:[{path:f.path,sha256:f.sha256,start:1,end:1}],supersedes:[]}],edges:[],alignments:[],gaps:[],conflicts:[],changes:[],coverageNotes:'One actual test file',feedbackResponse:'SYNTHETIC source read'};}};return {config,analyzer};}
it('real HTTP POST, same-origin guard, source scope, async analysis, history and durable server restart',async()=>{
 const {config,analyzer}=await fixture();const service=new HumanGoalService(config,analyzer);let app;
 try{app=await startServer(service);}catch(e){await service.close();throw e;}
 try{
 const request=(path:string,body?:unknown,origin=app!.url)=>fetch(`${app!.url}${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',Origin:origin}:{},body:body?JSON.stringify(body):undefined});
 expect((await request('/')).status).toBe(200);expect((await request('/api/projects')).status).toBe(200);
 expect((await request('/api/projects/test/analyze',{expectedGeneration:0,idempotencyKey:'bad'},'https://evil.example')).status).toBe(403);
 const payload={expectedGeneration:0,idempotencyKey:'http-goal',kind:'desired-change',originalText:'SYNTHETIC keep source refs',author:'test',provenance:'authored synthetic case',targetIds:[],clauses:[{id:'trace',text:'Preserve source refs',importance:'core'}]};
 expect((await request('/api/projects/test/feedback',payload)).status).toBe(200);await service.idle();const s:any=await(await request('/api/projects/test/state')).json();expect(s.views).toHaveLength(1);expect(s.views[0].analysis.modules.some((m:any)=>m.kind==='proposed')).toBe(true);expect(s.feedback[0].originalText).toBe(payload.originalText);expect((await request('/api/projects/test/feedback',{...payload,idempotencyKey:'stale'})).status).toBe(409);
 expect((await request('/api/projects/test/source?path=..%2Foutside')).status).toBe(400);expect((await request('/api/projects/unknown/state')).status).toBe(404);expect((await request('/api/projects/test/history')).status).toBe(200);
 await app.close();app=undefined;const reopened=new HumanGoalService(config,analyzer);const second=await startServer(reopened);try{const restored:any=await(await fetch(`${second.url}/api/projects/test/state`)).json();expect(restored.views[0].attemptId).toBe(s.views[0].attemptId);expect(restored.feedback).toEqual(s.feedback);}finally{await second.close();}
 }finally{if(app)await app.close();}
});
it('CLI entry actually executes outside tsconfig without invoking a real model',async()=>{const {config}=await fixture();const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config));const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/human-goal-workbench.ts','inspect','--config',configPath,'--project','test']);expect(JSON.parse(result.stdout).state.projectId).toBe('test');});
it('DOM uses text content, graph and text alternative share IDs; feedback form keeps original input',async()=>{
 const {config,analyzer}=await fixture();const service=new HumanGoalService(config,analyzer);service.feedback('test',{expectedGeneration:0,idempotencyKey:'dom-goal',originalText:'SYNTHETIC original expectation',kind:'desired-change',author:'test',provenance:'test',clauses:[{id:'trace',text:'Preserve source refs',importance:'core'}]});await service.idle();const s=service.read('test');await service.close();const view={...s.views[0],statuses:{'module-main':'implemented-unverified'}};const html=await readFile('src/human-goal-workbench/index.html','utf8'),script=await readFile('src/human-goal-workbench/client.js','utf8');const dom=new JSDOM(html,{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.fetch=async(url:string)=>({ok:true,json:async()=>url==='/api/projects'?{projects:config.projects}:{...s,views:[view],currentView:0,attempts:s.attempts.map(a=>({...a,inputHash:a.input.inputHash,goalVersion:a.input.goal?.version??null,sourceHash:a.input.source.hash,plan:a.input.plan}))}});w.eval(script);await new Promise(r=>setTimeout(r,30));try{expect(w.document.getElementById('purpose').textContent).toContain('<img');expect(w.document.querySelector('img')).toBeNull();expect(w.pwned).toBeUndefined();expect(w.document.getElementById('mainline-panel').hidden).toBe(false);expect(w.document.getElementById('workflow-content').textContent).toContain('未建立工作主线');w.document.getElementById('view-implementation').click();expect(w.document.querySelectorAll('.node').length).toBe(view.analysis.modules.filter(m=>m.kind==='discovered').length);expect(w.document.querySelectorAll('#graph-list button').length).toBe(view.analysis.modules.filter(m=>m.kind==='discovered').length);expect(w.document.querySelectorAll('#proposed-capabilities button').length).toBe(view.analysis.modules.filter(m=>m.kind==='proposed').length);w.document.querySelector('.node').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(w.document.getElementById('detail-title').textContent).toBe('SYNTHETIC source');w.document.getElementById('edit-goal').click();expect(w.document.querySelector('#dialog-body textarea').value).toBe('SYNTHETIC original expectation');expect(script).not.toMatch(/\.innerHTML\s*=/);}finally{dom.window.close();}
});


it('DOM raw-only save exposes saved goal, elapsed analysis, stale graph and completion or failure after polling',async()=>{
 const {config,analyzer}=await fixture();const service=new HumanGoalService(config,analyzer);let dom:any;
 try{
 service.feedback('test',{expectedGeneration:0,idempotencyKey:'lifecycle-first',originalText:'Original intention',kind:'desired-change',author:'test',provenance:'test',clauses:[{id:'trace',text:'Preserve source refs',importance:'core'}]});await service.idle();
 let snapshot=service.read('test');let active:any=null;let poll:()=>Promise<void>=async()=>{};
 const html=await readFile('src/human-goal-workbench/index.html','utf8'),script=await readFile('src/human-goal-workbench/client.js','utf8');
 dom=new JSDOM(html,{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
 w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.setInterval=(fn:()=>Promise<void>)=>{poll=fn;return 1;};
 const publicState=()=>({...snapshot,attempts:[...snapshot.attempts.map(a=>({...a,inputHash:a.input.inputHash,goalVersion:a.input.goal?.version??null,sourceHash:a.input.source.hash,plan:a.input.plan})),...(active?[active]:[])]});
 w.fetch=async(url:string,options:any)=>({ok:true,json:async()=>{
  if(url==='/api/projects')return {projects:config.projects};
  if(url.endsWith('/feedback')){const body=JSON.parse(options.body);const result=service.feedback('test',{...body,analyze:false});snapshot=service.read('test');active={id:'lifecycle-attempt',state:'running',goalVersion:snapshot.goals.at(-1)!.version,inputHash:'a'.repeat(64),attemptNumber:1,totalBudgetMs:null,usedMs:0,startedAt:new Date(Date.now()-65000).toISOString(),createdAt:new Date(Date.now()-65000).toISOString(),promoted:false};return result;}
  return publicState();
 }});
 w.eval(script);await new Promise(r=>setTimeout(r,30));const d=w.document,oldGraph=d.getElementById('graph').textContent;
 d.getElementById('edit-goal').click();d.querySelector('#dialog-body textarea').value='New intent <img src=x onerror="window.pwned=1">';
 await d.querySelector('#dialog-body form').onsubmit(new w.Event('submit',{cancelable:true}));
 expect(snapshot.goals.at(-1)?.clauses).toHaveLength(2);expect(d.getElementById('goal-analysis-status').textContent).toContain('已保存目标 G2');
 expect(d.getElementById('map-analysis-status').textContent).toContain('正在分析目标 G2');expect(d.getElementById('map-analysis-status').textContent).toContain('1 分');expect(d.getElementById('map-analysis-status').textContent).toContain('保留上次图');expect(d.getElementById('graph').textContent).toBe(oldGraph);expect(d.querySelector('img')).toBeNull();
 active.startedAt=new Date(Date.now()-125000).toISOString();await poll();expect(d.getElementById('map-analysis-status').textContent).toContain('2 分');
 active={...active,state:'partial',promoted:false,error:'STALE_RESULT',usedMs:125000};await poll();expect(d.getElementById('map-analysis-status').textContent).toContain('未发布');expect(d.getElementById('map-analysis-status').textContent).toContain('保留上次图');
 active={...active,state:'failed',error:'Synthetic failure'};await poll();expect(d.getElementById('map-analysis-status').textContent).toContain('分析失败');expect(d.getElementById('goal-analysis-status').textContent).toContain('已保存目标 G2');
 snapshot.views.push({...snapshot.views[0],attemptId:active.id,goal:snapshot.goals.at(-1)!,generation:snapshot.generation});snapshot.currentView=1;active={...active,state:'partial',promoted:true,error:undefined};await poll();
 expect(d.getElementById('map-analysis-status').textContent).toContain('分析完成');expect(d.getElementById('map-analysis-status').textContent).toContain('图已更新');expect(d.getElementById('map-analysis-status').textContent).toContain('部分来源');expect(d.getElementById('map-analysis-status').textContent).not.toContain('保留上次图');
 }finally{dom?.window.close();await service.close();}
});

// Browser-only interactions: no server, provider, or new dependencies.
async function readabilityDom() {
 const {config,analyzer}=await fixture();const service=new HumanGoalService(config,analyzer);
 service.feedback('test',{expectedGeneration:0,idempotencyKey:'readability',originalText:'完整目标原文'.repeat(80),kind:'desired-change',author:'test',provenance:'synthetic',clauses:[{id:'trace',text:'保留可核对来源',importance:'core'}]});await service.idle();
 const saved=service.read('test');await service.close();const current:any=JSON.parse(JSON.stringify(saved.views[0]));
 current.analysis.modules=Array.from({length:14},(_,i)=>({...current.analysis.modules[0],id:`n${i}`,title:i===0?'完整长标题'.repeat(40):`能力 ${i}`,responsibility:`职责 ${i}`}));
 current.analysis.edges=Array.from({length:12},(_,i)=>({id:`e${i}`,from:`n${i}`,to:`n${(i+1)%12}`,label:`传递 ${i}`,expected:'完整传递',actual:'来源可见',refs:[]}));
 current.analysis.alignments=[{clauseIds:['trace'],targetIds:['n0'],status:'unknown',rationale:'待核对',refs:[]}];
 current.statuses=Object.fromEntries([...current.analysis.modules.map((m:any)=>[m.id,'implemented-unverified']),...current.analysis.edges.map((e:any)=>[e.id,'verified-mismatch'])]);
 current.gaps=[2,1].map(rank=>({id:`g${rank}`,rank,lifecycle:'open',certainty:'unknown',kind:'missing-evidence',expected:`差距 ${rank}`,actual:'缺观察',action:`调查 ${rank}`,nextObservation:'检查原件',targetIds:['n0'],clauseIds:['trace'],refs:[],counterEvidence:[],causeHypotheses:[],prerequisites:[],verificationPlan:'核对',uncertainty:'未知'}));
 const old={...current,attemptId:'historical-view',analysis:{...current.analysis,purpose:'历史解释'}};
 const round={id:'old-round',purpose:'历史轮次完整目的',status:'completed',mode:'historical-replay',goalHash:current.goal.hash,viewAttemptId:old.attemptId,stale:true,attempts:[],verified:[],reported:'代理报告',relevance:'待核对',next:'补充观察',remaining:'剩余验证',mapping:'历史映射',before:{sourceHash:current.source.hash,coverage:[]},after:{sourceHash:current.source.hash},deltas:[],touchedTargets:['n0'],feedbackIds:[]};
 let snapshot:any={...saved,views:[current],currentView:0,roundViews:[old],rounds:{revision:1,rounds:[round],registrations:[],policy:{}},attempts:saved.attempts.map(a=>({...a,goalVersion:a.input.goal?.version,sourceHash:a.input.source.hash,plan:a.input.plan}))};
 const dom=new JSDOM(await readFile('src/human-goal-workbench/index.html','utf8'),{url:'http://127.0.0.1:9999',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;let poll:any;
 w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.setInterval=(fn:any)=>{poll=fn;return 1;};
 w.HTMLElement.prototype.getBoundingClientRect=()=>({width:860,height:420,x:0,y:0,top:0,left:0,right:860,bottom:420});
 w.fetch=async(url:string)=>({ok:true,json:async()=>url==='/api/projects'?{projects:[...config.projects,{...config.projects[0],id:'second',label:'第二个项目'}]}:snapshot});
 w.eval(await readFile('src/human-goal-workbench/client.js','utf8'));await new Promise(r=>setTimeout(r,30));
 w.document.getElementById('view-implementation').click();
 return {dom,w,d:w.document,current,getSnapshot:()=>snapshot,poll:()=>poll(),publish:async(next:any)=>{snapshot={...snapshot,views:[...snapshot.views,next],currentView:snapshot.views.length,generation:snapshot.generation+1};await poll();},update:async()=>{snapshot={...snapshot,generation:snapshot.generation+1,rounds:{...snapshot.rounds,revision:snapshot.rounds.revision+1}};await poll();}};
}
it('module detail deduplicates goal clause IDs in a collapsed disclosure and retains every source and feedback action',async()=>{
 const {dom,w,d,current,update}=await readabilityDom();try{
 const original='完整目标 <img src=x>，保留原文。'.repeat(30),base=current.analysis.modules[0].refs[0];
 current.goal.clauses=[{id:'first',text:original,importance:'core'},{id:'second',text:original,importance:'supporting'}];
 const refs=[base,{...base,start:2,end:3},{...base,sha256:'b'.repeat(64),start:4,end:5}];
 current.analysis.alignments=refs.map((ref,i)=>({id:`alignment-${i}`,clauseIds:i===2?['first','second']:['first','first'],targetIds:['n0'],status:'unknown',rationale:'待核对',refs:[ref]}));
 await update();d.querySelector('.node[data-id="n0"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 const detail=d.getElementById('detail');
 expect([...detail.querySelectorAll('p')].filter((p:any)=>p.textContent===original)).toHaveLength(0);
 const goals=detail.querySelector('details.detail-goals');expect(goals).not.toBeNull();expect(goals.open).toBe(false);expect(goals.querySelector('summary').textContent).toContain('2');
 goals.open=true;expect([...goals.querySelectorAll('li')].map((li:any)=>[li.dataset.clauseId,li.textContent])).toEqual([['first',original],['second',original]]);expect(detail.querySelector('img')).toBeNull();
 const requested:string[]=[];w.fetch=async(url:string)=>{requested.push(url);return {ok:true,json:async()=>({text:'原始来源',sha256:base.sha256})};};
 const sourceButtons=[...goals.querySelectorAll('.source-ref')];expect(sourceButtons).toHaveLength(3);
 for(const [i,b]of sourceButtons.entries()){b.click();await new Promise(r=>setTimeout(r,0));const url=new URL(requested[i],'http://127.0.0.1:9999');expect(url.searchParams.get('path')).toBe(refs[i].path);expect(url.searchParams.get('sha256')).toBe(refs[i].sha256);expect(url.searchParams.get('start')).toBe(String(refs[i].start));expect(url.searchParams.get('end')).toBe(String(refs[i].end));d.getElementById('close-dialog').click();}
 expect(detail.textContent).toContain('职责 0');expect(detail.textContent).toContain('你希望它负责');expect(detail.querySelector('button.primary').closest('details')).toBeNull();detail.querySelector('button.primary').click();expect(d.querySelectorAll('#dialog-body textarea')[1].value).toBe('职责 0');
 }finally{dom.window.close();}
});
it('desktop tabs keep current analysis separate from explicitly opened historical maps',async()=>{
 const {dom,d,current,update}=await readabilityDom();try{
 expect(d.getElementById('rounds-panel')?.hidden).toBe(true);expect(d.getElementById('purpose').textContent).toBe(current.analysis.purpose);
 d.getElementById('tab-rounds').click();expect(d.getElementById('rounds-panel').hidden).toBe(false);expect(d.getElementById('map-workspace').hidden).toBe(true);
 d.querySelector('.round-link').click();expect(d.getElementById('purpose').textContent).toBe(current.analysis.purpose);
 d.getElementById('round-map').click();expect(d.getElementById('map-context').textContent).toContain('历史');expect(d.getElementById('purpose').textContent).toBe('历史解释');
 await update();expect(d.getElementById('purpose').textContent).toBe('历史解释');
 d.getElementById('tab-map').click();expect(d.getElementById('purpose').textContent).toBe(current.analysis.purpose);expect(d.getElementById('rounds-panel').hidden).toBe(true);
 }finally{dom.window.close();}
});
it('cycle map stays bounded and readable; keyboard focus shows direct neighbors and exact statuses',async()=>{
 const {dom,w,d}=await readabilityDom();try{
 const nodes=[...d.querySelectorAll('.node')] as any[];const xs=nodes.map(n=>Number(n.getAttribute('transform').match(/translate\(([-\d.]+)/)[1]));expect(Math.max(...xs)-Math.min(...xs)).toBeLessThan(1500);
 d.getElementById('fit').click();expect(Number(d.querySelector('#scene').getAttribute('transform').match(/scale\(([^)]+)/)[1])).toBeGreaterThanOrEqual(.85);
 nodes[0].dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 expect(d.querySelector('.edge[data-id="e0"]').classList.contains('related')).toBe(true);expect(d.querySelector('.node[data-id="n1"]').classList.contains('related')).toBe(true);expect(d.querySelector('.node[data-id="n11"]').classList.contains('related')).toBe(true);expect(d.querySelector('.node[data-id="n2"]').classList.contains('dim')).toBe(true);
 expect(d.querySelector('.edge[data-id="e0"]').dataset.status).toBe('verified-mismatch');expect(d.getElementById('graph-legend').textContent).toContain('限定范围不符');expect(d.getElementById('detail-title').textContent).toBe('完整长标题'.repeat(40));
 expect(d.querySelector('.node title').textContent).toBe('完整长标题'.repeat(40));expect(d.getElementById('graph-list').textContent).toContain('完整长标题'.repeat(40));
 d.querySelector('#gaps .gap').click();expect(d.getElementById('detail').textContent).toContain('差距 1');expect(d.querySelector('.node[data-id="n0"]').classList.contains('related')).toBe(true);
 }finally{dom.window.close();}
});
it('polling retains draft, open evidence, search, camera and reading selection',async()=>{
 const {dom,w,d,update}=await readabilityDom();try{
 d.getElementById('text-alternative').open=true;d.querySelector('.node').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 d.getElementById('search').value='能力';d.getElementById('search').dispatchEvent(new w.Event('input'));const camera=d.querySelector('#scene').getAttribute('transform');
 d.getElementById('edit-goal').click();const input=d.querySelector('#dialog-body textarea');input.value='尚未提交的纠正';input.focus();input.setSelectionRange(2,4);
 await update();expect(d.querySelector('#dialog-body textarea')).toBe(input);expect(input.value).toBe('尚未提交的纠正');expect(input.selectionStart).toBe(2);expect(d.activeElement).toBe(input);expect(d.getElementById('text-alternative').open).toBe(true);expect(d.getElementById('search').value).toBe('能力');expect(d.querySelector('#scene').getAttribute('transform')).toBe(camera);
 }finally{dom.window.close();}
});
it('full goal and diagnosis remain accessible; overall recommendation precedes ranked gaps',async()=>{
 const {dom,w,d,current,update}=await readabilityDom();try{
 current.analysis.diagnosis={scope:'workflow',scopeReason:'来自来源',certainty:'unknown',conclusion:'完整判断'.repeat(100),recommendation:{action:'先查主线瓶颈',reason:'跨能力证据',options:[],verificationJourney:'完整验证旅程'},taskAssessment:{reason:'为何相关',remaining:'剩余核对'},journeys:[],evidence:[],counterEvidence:[],alternatives:[]};await update();
 expect(d.getElementById('overall-diagnosis').textContent).toContain('先查主线瓶颈');expect(d.querySelector('#gaps .gap').textContent).toContain('差距 1');
 d.getElementById('overview-evidence').click();expect(d.getElementById('dialog-body').textContent).toContain('完整目标原文'.repeat(80));expect(d.getElementById('dialog-body').textContent).toContain('完整判断'.repeat(100));expect(d.getElementById('dialog-body').textContent).toContain('完整验证旅程');
 d.getElementById('close-dialog').click();d.querySelector('.node').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.querySelectorAll('.node.dim').length).toBeGreaterThan(0);d.getElementById('close-detail').click();expect(d.querySelectorAll('.node.dim')).toHaveLength(0);
 }finally{dom.window.close();}
});
it('feedback keeps its base generation after polling and retains the draft on conflict',async()=>{
 const {dom,w,d,update,getSnapshot}=await readabilityDom();try{
 const baseGeneration=getSnapshot().generation;const saved=JSON.parse(w.localStorage.getItem('hg-reading'));expect(saved.projectId).toBe('test');d.getElementById('edit-goal').click();const input=d.querySelector('#dialog-body textarea');input.value='保留这段草稿';let sent:any;await update();
 w.fetch=async(_url:string,options:any)=>{sent=JSON.parse(options.body);return {ok:false,json:async()=>({code:'STALE_GENERATION',message:'目标已变化，请比较'})};};
 await d.querySelector('#dialog-body form').onsubmit(new w.Event('submit',{cancelable:true}));expect(sent.expectedGeneration).toBe(baseGeneration);expect(d.getElementById('dialog').open).toBe(true);expect(input.value).toBe('保留这段草稿');expect(d.getElementById('dialog-body').textContent).toContain('STALE_GENERATION');
 }finally{dom.window.close();}
});
it('a project switch rejects late state from the previous project and preserves theme',async()=>{
 const {dom,w,d,getSnapshot,poll}=await readabilityDom();try{
 let finish:any;w.fetch=(url:string)=>new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({generation:999})});});const oldPoll=poll();
 d.getElementById('project').value='second';
 const next={...getSnapshot(),projectId:'second',views:[],currentView:null,roundViews:[],rounds:{revision:1,rounds:[],registrations:[]}};
 d.getElementById('theme').click();await d.getElementById('project').onchange();w.fetch=async()=>({ok:true,json:async()=>next});finish();await oldPoll;
 expect(d.getElementById('identity').textContent).toContain('第二个项目');expect(d.querySelectorAll('.node')).toHaveLength(0);expect(d.body.classList.contains('dark')).toBe(true);expect(JSON.parse(w.localStorage.getItem('hg-reading')).projectId).toBe('second');
 }finally{dom.window.close();}
});

it('new publication wins over remembered rounds, while explicit history retains its own camera',async()=>{
 const {dom,d,current,publish}=await readabilityDom();try{
 d.getElementById('zoom-in').click();const before=d.querySelector('#scene').getAttribute('transform');
 const next={...current,attemptId:'new-publication',analysis:{...current.analysis,purpose:'最新来源解释'}};await publish(next);
 expect(d.getElementById('purpose').textContent).toBe('最新来源解释');expect(d.querySelector('#scene').getAttribute('transform')).not.toBe(before);
 d.getElementById('tab-rounds').click();d.getElementById('round-map').click();d.getElementById('zoom-in').click();const historyCamera=d.querySelector('#scene').getAttribute('transform');
 d.getElementById('tab-map').click();expect(d.getElementById('purpose').textContent).toBe('最新来源解释');d.getElementById('tab-rounds').click();d.getElementById('round-map').click();expect(d.querySelector('#scene').getAttribute('transform')).toBe(historyCamera);expect(d.getElementById('map-context').hidden).toBe(false);
 }finally{dom.window.close();}
});
it('layout is invariant to source ordering and supports self loops and keyboard pan without losing raw labels',async()=>{
 const {dom,w,d,current,publish}=await readabilityDom();try{
 const original=new Map([...d.querySelectorAll('.node')].map((n:any)=>[n.dataset.id,n.getAttribute('transform')]));
 const next={...current,attemptId:'reordered',analysis:{...current.analysis,modules:[...current.analysis.modules].reverse(),edges:[...current.analysis.edges].reverse()}};await publish(next);
 for(const node of d.querySelectorAll('.node'))expect(node.getAttribute('transform')).toBe(original.get(node.dataset.id));
 const self={...next,attemptId:'with-self-loop',analysis:{...next.analysis,edges:[...next.analysis.edges,{...next.analysis.edges[0],id:'self',from:'n0',to:'n0',label:'完整自环说明'}]}};await publish(self);
 const edge=d.querySelector('.edge[data-id="self"]');expect(edge).not.toBeNull();expect(edge.querySelector('path:not(.hit)').getAttribute('d')).not.toMatch(/NaN|undefined/);edge.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.getElementById('detail-title').textContent).toBe('完整自环说明');
 const camera=d.querySelector('#scene').getAttribute('transform');d.getElementById('graph-wrap').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));expect(d.querySelector('#scene').getAttribute('transform')).not.toBe(camera);
 }finally{dom.window.close();}
});

it('ten source capabilities fit the desktop canvas at readable scale; reset removes hidden focus and filtering',async()=>{
 const {dom,w,d,current,publish}=await readabilityDom();try{
 d.getElementById('graph-wrap').getBoundingClientRect=()=>({width:956,height:320,x:0,y:0,top:0,left:0,right:956,bottom:320});
 const ten={...current,attemptId:'ten-capabilities',analysis:{...current.analysis,modules:current.analysis.modules.slice(0,10),edges:current.analysis.edges.filter((e:any)=>Number(e.from.slice(1))<10&&Number(e.to.slice(1))<10)}};await publish(ten);
 const transform=d.querySelector('#scene').getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)/),[x,y,scale]=transform.slice(1).map(Number);expect(scale).toBeGreaterThanOrEqual(.85);
 for(const node of d.querySelectorAll('.node')){const [nx,ny]=node.getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\)/).slice(1).map(Number),rect=node.querySelector('rect');expect(x+nx*scale).toBeGreaterThanOrEqual(0);expect(y+ny*scale).toBeGreaterThanOrEqual(0);expect(x+(nx+Number(rect.getAttribute('width')))*scale).toBeLessThanOrEqual(956);expect(y+(ny+Number(rect.getAttribute('height')))*scale).toBeLessThanOrEqual(320);}
 expect(d.querySelectorAll('.edge')).toHaveLength(ten.analysis.edges.length);d.querySelector('.node').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));d.getElementById('search').value='nothing matches';d.getElementById('search').dispatchEvent(new w.Event('input'));d.getElementById('fit').click();expect(d.querySelectorAll('.dim')).toHaveLength(0);expect(d.getElementById('search').value).toBe('');expect(d.body.classList.contains('inspector-open')).toBe(false);
 }finally{dom.window.close();}
});

it('product mainline shows explicit non-project branches and feedback, separates desired work and drills into source-bound implementation',async()=>{
 const {dom,w,d,current,update}=await readabilityDom();try{
 const ref=current.analysis.modules[0].refs[0];
 const step=(id:string,title:string)=>({id,title,purpose:'完成订单履约',actor:'仓库人员',responsibility:title,inputs:['订单'],outputs:['订单处理结果'],actual:'源码支持，尚未执行',state:'source-supported',targetIds:['n0'],clauseIds:['trace'],refs:[ref],uncertainty:'运行未知'});
 current.analysis.workflow={status:'established',summary:'依据订单源码识别的旅程',coverage:'registered-scope',unknowns:['外部物流未读取'],journeys:[{id:'orders',title:'订单履约',purpose:'用户取得商品',clauseIds:['trace'],observed:{steps:[step('accept','接收订单 <img src=x>'),step('ship','发货'),step('hold','暂存'),{...step('unknown','外部物流'),state:'unknown',targetIds:[],refs:[]}],links:[{id:'ship-link',from:'accept',to:'ship',kind:'branch',condition:'库存充足',meaning:'传递可履约订单',state:'source-supported',refs:[ref]},{id:'hold-link',from:'accept',to:'hold',kind:'branch',condition:'库存不足',meaning:'暂存订单',state:'source-supported',refs:[ref]},{id:'retry-link',from:'hold',to:'accept',kind:'feedback',condition:'补充库存',meaning:'再次检查',state:'source-supported',refs:[ref]}]},desired:{steps:[{...step('notify','通知客户'),state:'proposed',refs:[],actual:'目标期望'}],links:[]}}]};
 await update();d.getElementById('view-mainline').click();expect(d.getElementById('mainline-panel').hidden).toBe(false);expect(d.getElementById('map-panel').hidden).toBe(true);
 expect(d.querySelectorAll('.workflow-step')).toHaveLength(4);expect(d.querySelectorAll('[data-flow-link]')).toHaveLength(3);expect(d.querySelector('.workflow-step[data-step-id="notify"]')).toBeNull();expect(d.getElementById('workflow-desired').textContent).toContain('通知客户');expect(d.querySelector('img')).toBeNull();
 const pos=(id:string)=>d.querySelector(`[data-step-id="${id}"]`).getAttribute('transform').match(/translate\((\d+) (\d+)\)/).slice(1).map(Number);
 expect(pos('ship')[0]).toBe(pos('hold')[0]);expect(pos('ship')[0]).toBeGreaterThan(pos('accept')[0]);expect(pos('ship')[1]).not.toBe(pos('hold')[1]);expect(d.querySelector('[data-flow-link="retry-link"] title').textContent).toContain('反馈');
 expect(d.getElementById('workflow-text').textContent).toContain('库存不足');expect(d.getElementById('workflow-text').textContent).toContain('再次检查');
 const ship=d.querySelector('[data-step-id="ship"]');ship.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.getElementById('detail-title').textContent).toBe('发货');expect(d.getElementById('detail').textContent).toContain('仓库人员');expect(d.querySelector('#detail .source-ref').textContent).toContain(ref.path);
 const mapped=[...d.querySelectorAll('#detail button')].find((b:any)=>b.textContent===current.analysis.modules[0].title) as any;mapped.click();expect(d.getElementById('map-panel').hidden).toBe(false);expect(d.getElementById('detail-title').textContent).toBe(current.analysis.modules[0].title);
 expect(d.getElementById('graph-list').textContent).toContain('未分类');expect(d.getElementById('graph-list').textContent).toContain('历史关系');
 d.getElementById('view-mainline').click();d.querySelector('[data-step-id="unknown"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.getElementById('detail').textContent).toContain('尚未定位实现');
 d.getElementById('workflow-text').open=true;ship.focus();await update();expect(d.getElementById('workflow-text').open).toBe(true);
 d.getElementById('tab-rounds').click();d.getElementById('round-map').click();expect(d.getElementById('workflow-content').textContent).toContain('未建立工作主线');expect(d.querySelectorAll('.workflow-step')).toHaveLength(0);expect(d.getElementById('map-context').hidden).toBe(false);
 d.getElementById('tab-map').click();expect(d.querySelectorAll('.workflow-step')).toHaveLength(4);expect(d.getElementById('workflow-analysis-status').textContent).toContain('当前判断待更新');
 }finally{dom.window.close();}
});


// SVG coordinates verify the projection without claiming browser layout or real model quality.
function workflowBoxes(d:any){return [...d.querySelectorAll('.workflow-step')].map((n:any)=>{
 const [x,y]=n.getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\)/).slice(1).map(Number),r=n.querySelector('rect');
 return {id:n.dataset.stepId,x,y,width:Number(r.getAttribute('width')),height:Number(r.getAttribute('height'))};
});}
function viewportWorkflow(current:any,count:number){
 const ref=current.analysis.modules[0].refs[0];
 const steps=Array.from({length:count},(_,i)=>({id:`step-${i}`,title:['登记本轮目的与观察起点','外部Agent执行开发','接收事件并显示实际变化','核对证据并判断本轮结果'][i%4],purpose:'原始步骤目的',actor:'协作者',responsibility:'核对实际变化',inputs:['输入'],outputs:['完整输出内容'.repeat(10)],actual:'全部当前事实'.repeat(30),state:i===1?'unknown':'source-supported',targetIds:i===1?[]:['n0'],clauseIds:['trace'],refs:[ref],uncertainty:'未执行运行验证'}));
 const links=steps.slice(1).map((step,i)=>({id:`link-${i}`,from:steps[i].id,to:step.id,kind:i===1?'branch':'sequence',condition:'保留全部条件 <img src=x> '.repeat(20),meaning:'显式业务传递',state:'source-supported',refs:[ref]}));
 links.push({id:'return',from:steps.at(-1)!.id,to:steps[0].id,kind:'feedback',condition:'用户纠正后再次核对',meaning:'只在明确反馈条件下返回',state:'source-supported',refs:[ref]});
 return {status:'established',summary:'完整模型说明'.repeat(200),coverage:'registered-scope',unknowns:['未确定边界'.repeat(100)],journeys:[{id:'generic',title:'SYNTHETIC 通用工作流',purpose:'核对这一轮的实际进展。'.repeat(50),clauseIds:['trace'],observed:{steps,links},desired:{steps:[],links:[]}}]};
}
it.each([2,3,4])('%i steps plus explicit feedback fit the desktop mainline at readable fixed size',async count=>{
 const {dom,w,d,current,update}=await readabilityDom();try{
 const workflow=viewportWorkflow(current,count);current.analysis.workflow=workflow;await update();d.getElementById('view-mainline').click();
 const boxes=workflowBoxes(d),svg=d.querySelector('#workflow-scroll svg');expect(boxes).toHaveLength(count);
 expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(932);expect(Number(svg.getAttribute('height'))).toBeLessThanOrEqual(220);
 expect(new Set(boxes.map(b=>b.y)).size).toBe(1);
 for(const [i,b]of boxes.entries()){expect(b.width).toBeGreaterThanOrEqual(190);expect(b.height).toBeGreaterThanOrEqual(105);expect(b.x).toBeGreaterThanOrEqual(0);expect(b.x+b.width).toBeLessThanOrEqual(932);expect(b.y+b.height).toBeLessThanOrEqual(220);if(i)expect(b.x).toBeGreaterThan(boxes[i-1].x+boxes[i-1].width);}
 const style=d.createElement('style');style.textContent=await readFile('src/human-goal-workbench/styles.css','utf8');d.head.append(style);
 expect(parseFloat(w.getComputedStyle(d.querySelector('.workflow-step text')).fontSize)).toBeGreaterThanOrEqual(14);expect(parseFloat(w.getComputedStyle(d.querySelector('.workflow-meta')).fontSize)).toBeGreaterThanOrEqual(12);
 expect(d.getElementById('workflow-basis').open).toBe(false);expect(d.getElementById('workflow-basis').textContent).toContain(workflow.summary);expect(d.getElementById('workflow-basis').textContent).toContain(workflow.journeys[0].purpose);expect(d.getElementById('workflow-unknowns').textContent).toContain(workflow.unknowns[0]);
 expect(d.getElementById('workflow-scroll').compareDocumentPosition(d.getElementById('workflow-basis'))&w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 const feedback=d.querySelector('[data-flow-link="return"]');expect(feedback.classList.contains('feedback')).toBe(true);expect(feedback.querySelector('path:not(.workflow-hit)').getAttribute('d')).toContain(`V${boxes[0].y+boxes[0].height+28}`);
 const link=d.querySelector('[data-flow-link="link-0"]');expect(link.querySelector('text').textContent).toContain('＊');link.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.getElementById('detail').textContent).toContain(workflow.journeys[0].observed.links[0].condition);expect(d.querySelector('#detail .source-ref')).not.toBeNull();expect(d.querySelector('img')).toBeNull();
 link.focus();d.getElementById('workflow-basis').open=true;await update();expect(d.activeElement.dataset.flowLink).toBe('link-0');expect(d.getElementById('workflow-basis').open).toBe(true);
 d.querySelector('[data-step-id="step-1"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true}));expect(d.getElementById('detail-title').textContent).toBe(workflow.journeys[0].observed.steps[1].title);expect(d.getElementById('detail').textContent).toContain(workflow.journeys[0].observed.steps[1].actual);
 }finally{dom.window.close();}
});
it('branch merge, disconnected steps and cycles keep explicit topology; large flows offer keyboard overflow',async()=>{
 const {dom,w,d,current,update}=await readabilityDom();try{
 const workflow=viewportWorkflow(current,8),flow=workflow.journeys[0].observed;
 const link=(id:string,from:number,to:number,kind='sequence')=>({...flow.links[0],id,from:`step-${from}`,to:`step-${to}`,kind});
 flow.links=[link('a',0,1,'branch'),link('b',0,2,'branch'),link('c',1,3),link('d',2,3),link('skip',0,3),link('cycle-a',4,5),link('cycle-b',5,4),link('feedback',3,0,'feedback')];
 flow.steps.reverse();current.analysis.workflow=workflow;await update();
 const boxes=workflowBoxes(d),box=(id:number)=>boxes.find(b=>b.id===`step-${id}`)!;
 expect(box(1).x).toBe(box(2).x);expect(box(1).y).not.toBe(box(2).y);expect(box(1).x).toBeGreaterThan(box(0).x);expect(box(3).x).toBeGreaterThan(box(1).x);expect(box(4).x).toBe(box(5).x);expect(box(4).y).not.toBe(box(5).y);expect(box(6).x).toBe(box(0).x);
 for(const a of boxes)for(const b of boxes)if(a!==b)expect(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y).toBe(true);
 expect([...d.querySelectorAll('[data-flow-link]')].map((n:any)=>n.dataset.flowLink).sort()).toEqual(flow.links.map(l=>l.id).sort());
 const bottom=Math.max(...boxes.map(b=>b.y+b.height));for(const id of ['skip','cycle-a','cycle-b','feedback']){const route=d.querySelector(`[data-flow-link="${id}"] path:not(.workflow-hit)`).getAttribute('d');expect(Number(route.match(/V([\d.]+)/)[1])).toBeGreaterThan(bottom);}
 current.analysis.workflow=viewportWorkflow(current,8);const longTitle='保留完整长标题及事实边界'.repeat(30);current.analysis.workflow.journeys[0].observed.steps[0].title=longTitle;await update();const longNode=d.querySelector('[data-step-id="step-0"]');expect(longNode.getAttribute('aria-label')).toContain(longTitle);longNode.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(d.getElementById('detail-title').textContent).toBe(longTitle);const scroll=d.getElementById('workflow-scroll');expect(Number(scroll.querySelector('svg').getAttribute('width'))).toBeGreaterThan(932);expect(d.getElementById('workflow-cue').textContent).toContain('横向 / 纵向滚动');
 scroll.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));scroll.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));expect(scroll.scrollLeft).toBe(80);expect(scroll.scrollTop).toBe(80);await update();expect(d.getElementById('workflow-scroll').scrollLeft).toBe(80);expect(d.getElementById('workflow-scroll').scrollTop).toBe(80);
 }finally{dom.window.close();}
});

it('goal review connects original clauses to responsibilities, scoped conditions and ranked gaps without accepting the business goal',async()=>{
 const {dom,d,current,getSnapshot,update}=await readabilityDom();try{
 const s=getSnapshot();s.diagnosisStatus='published';s.expectations=[{targetId:'n0',clauseIds:['trace'],responsibility:'人希望负责端到端目标核对'}];
 s.closedLoop={sourceHash:current.source.hash,confirmationMapping:{applicable:true},criteria:[{criterionId:'limited',text:'只有引用绑定的限定条件',clauseIds:['trace'],status:'passed',observable:'检查引用',evidence:[],targetIds:['n0']}],status:'verified'};await update();
 d.getElementById('review-goal').click();const card=d.querySelector('#dialog-body [data-clause-id="trace"]');expect(card.textContent).toContain('保留可核对来源');expect(card.textContent).toContain('1/1 项当前映射条件有通过证据');expect(card.textContent).toContain('完整目标含义待核对');expect(card.textContent).toContain('职责 0');expect(card.textContent).toContain('人希望负责端到端目标核对');
 const actions=[...card.querySelectorAll('button')].map((b:any)=>b.textContent);expect(actions.findIndex((x:string)=>x.startsWith('1. 差距 1'))).toBeLessThan(actions.findIndex((x:string)=>x.startsWith('2. 差距 2')));expect(d.querySelector('#dialog-body img')).toBeNull();
 [...card.querySelectorAll('button')].find((b:any)=>b.textContent==='核对 / 修改此模块')!.click();expect(d.querySelectorAll('#dialog-body textarea')[1].value).toBe('人希望负责端到端目标核对');
 d.getElementById('close-dialog').click();getSnapshot().diagnosisStatus='stale';await update();d.getElementById('review-goal').click();expect(d.querySelector('#dialog-body [data-clause-id="trace"]').textContent).toContain('0/0 项当前映射条件');expect(d.getElementById('dialog-body').textContent).toContain('不沿用通过结论');
 d.getElementById('close-dialog').click();d.getElementById('round-map').click();d.getElementById('review-goal').click();expect(d.getElementById('dialog-body').textContent).toContain('不沿用通过结论');
 }finally{dom.window.close();}
});
it('verification shows human-readable condition results and keeps every raw assertion in a closed disclosure',async()=>{
 const {dom,d,current,getSnapshot,update}=await readabilityDom();try{
 const s=getSnapshot();s.closedLoop={sourceHash:current.source.hash,criteria:[{scenarioTitle:'核对目标',text:'当前结果可追溯',observable:'从当前条件打开原件',status:'passed',mapping:'mapped',targetIds:['n0'],evidence:[{receiptId:'receipt-original',roundId:'round-original',checkId:'check-original',status:'passed',actual:'RAW ENGLISH ASSERTION',evidence:'{"original":"exact bytes <img src=x>"}',current:true}]}],receipts:[],runtimeCalls:[]};await update();
 [...d.querySelectorAll('#closed-loop-summary button')].find((b:any)=>b.textContent==='实际验证与调用')!.click();const body=d.getElementById('dialog-body');expect(body.textContent).toContain('条件通过');expect(body.textContent).toContain('RAW ENGLISH ASSERTION');const raw=[...body.querySelectorAll('details')].find((n:any)=>n.textContent.includes('RAW ENGLISH ASSERTION'));expect(raw.open).toBe(false);expect(raw.querySelector('summary').textContent).toContain('展开原始断言');expect(raw.textContent).toContain('receipt-original');expect(body.querySelector('img')).toBeNull();expect(body.textContent).toContain('查看实现 完整长标题');
 }finally{dom.window.close();}
});

it('goal review saves an explicit bounded opinion with fixed input basis and retains the draft on concurrent changes',async()=>{
 const {dom,w,d,current,getSnapshot,update}=await readabilityDom();try{
 const s=getSnapshot();s.closedLoop={sourceHash:current.source.hash,criteria:[],confirmationMapping:{applicable:true}};s.goalReviews={clauses:[{clauseId:'trace',status:'unreviewed'}]};await update();d.getElementById('review-goal').click();const card=d.querySelector('[data-clause-id="trace"]');expect(card.textContent).toContain('尚未记录目标核对意见');[...card.querySelectorAll('button')].find((b:any)=>b.textContent==='记录这项目标的核对结果')!.click();
 const form=d.querySelector('#dialog-body form'),select=form.querySelector('select'),areas=form.querySelectorAll('textarea');expect(select.value).toBe('unknown');select.value='mismatch';areas[0].value='我的反例 <img src=x onerror=bad>：看不出本轮推进哪项目标';areas[1].value='核对当前回执的实际用户结果';const generation=getSnapshot().generation;let sent:any;
 w.fetch=async(url:string,options:any)=>{if(url.endsWith('/feedback')){sent=JSON.parse(options.body);return {ok:false,json:async()=>({code:'STALE_BASE',message:'已变化'})};}return {ok:true,json:async()=>s};};
 await form.onsubmit(new w.Event('submit',{cancelable:true}));expect(sent).toMatchObject({expectedGeneration:generation,kind:'evidence-contribution',targetIds:[],author:'local-human',originalText:areas[0].value,goalReview:{clauseId:'trace',decision:'mismatch',goalHash:current.goal.hash,sourceHash:current.source.hash,analysisAttemptId:current.attemptId,nextObservation:areas[1].value}});expect(sent.clauses).toBeUndefined();expect(areas[0].value).toContain('我的反例');expect(form.textContent).toContain('原话仍在表单中');expect(d.querySelector('img')).toBeNull();
 }finally{dom.window.close();}
});
it('old goal review is inspectable but cannot override priority or claim current goal satisfaction',async()=>{
 const {dom,d,current,getSnapshot,update}=await readabilityDom();try{const s=getSnapshot();s.closedLoop={sourceHash:current.source.hash,criteria:[],confirmationMapping:{applicable:true},nextAction:'当前模型建议'};s.goalReviews={clauses:[{clauseId:'trace',status:'stale',decision:'unknown',feedbackId:'old-report',author:'reader',provenance:'older analysis',originalText:'旧版相符原话',nextObservation:'重核'}]};await update();d.getElementById('review-goal').click();const card=d.querySelector('[data-clause-id="trace"]');expect(card.textContent).toContain('旧核对意见');expect(card.textContent).toContain('旧版相符原话');expect(card.textContent).not.toContain('核对者报告相符');}finally{dom.window.close();}
});

it('guided reading keeps one round, scoped proof and raw reader answers together without pre-answering for the reader',async()=>{
 const {dom,w,d,current,getSnapshot,update}=await readabilityDom();try{
 const s=getSnapshot(),round=s.rounds.rounds[0];round.sourceStale=false;round.purpose='本轮减少读取等待';round.after={sourceHash:current.source.hash};
 s.diagnosisStatus='published';s.closedLoop={sourceHash:current.source.hash,confirmationMapping:{applicable:true},criteria:[{criterionId:'limited',text:'保留当前来源',observable:'核对来源 hash',clauseIds:['trace'],targetIds:['n0'],status:'passed',evidence:[{receiptId:'this-round',roundId:round.id,current:true}]},{criterionId:'other',text:'不属于所选目标的证明',clauseIds:['other'],targetIds:[],status:'passed',evidence:[]}],receipts:[{id:'this-round',current:true,binding:{roundId:round.id,goalHash:current.goal.hash,sourceHash:current.source.hash}},{id:'another-round',current:true,binding:{roundId:'other-round',goalHash:current.goal.hash,sourceHash:current.source.hash}}]};
 await update();d.getElementById('review-round').click();const body=d.getElementById('dialog-body');expect(body.textContent).toContain('本轮减少读取等待');expect(body.textContent).toContain('保留可核对来源');expect(body.textContent).toContain('完整目标原文');expect(d.getElementById('reader-answer').value).toBe('');
 const answers=['我想知道进度 <img src=x>','本轮减少读取等待','只看到来源保留证明，尚未验证读者理解','不知道是否真的看得懂','观察真实读者能否说明下一步'];
 for(let i=0;i<5;i++){d.getElementById('reader-answer').value=answers[i];if(i===2){expect(body.textContent).toContain('保留当前来源');expect(body.textContent).not.toContain('不属于所选目标的证明');expect([...body.querySelectorAll('[data-reader-receipt]')].map((n:any)=>n.dataset.readerReceipt)).toEqual(['this-round']);}d.getElementById('reader-next').click();}
 const form=body.querySelector('form');expect(form.querySelector('select').value).toBe('unknown');expect(body.querySelector('img')).toBeNull();let sent:any;w.fetch=async(url:string,options:any)=>{if(url.endsWith('/feedback')){sent=JSON.parse(options.body);return {ok:false,json:async()=>({code:'STALE_BASE',message:'测试拒绝，保留草稿'})};}return {ok:true,json:async()=>s};};
 await form.onsubmit(new w.Event('submit',{cancelable:true}));expect(sent.goalReview).toMatchObject({clauseId:'trace',goalHash:current.goal.hash,sourceHash:current.source.hash,analysisAttemptId:current.attemptId,decision:'unknown',nextObservation:answers[4]});for(const answer of answers)expect(sent.originalText).toContain(answer);expect(sent.originalText).toContain(round.id);expect(sent.author).toBe('local-human');expect(sent.clauses).toBeUndefined();expect(body.textContent).toContain('保留草稿');
 }finally{dom.window.close();}
});
it('guided reading preserves all answers on background updates and refuses to rebind or submit an obsolete draft',async()=>{
 const {dom,d,current,getSnapshot,update}=await readabilityDom();try{
 const s=getSnapshot();s.diagnosisStatus='published';s.closedLoop={sourceHash:current.source.hash,criteria:[],confirmationMapping:{applicable:true}};await update();d.getElementById('review-round').click();
 for(let i=0;i<5;i++){d.getElementById('reader-answer').value=`原话 ${i}`;d.getElementById('reader-next').click();}const form=d.querySelector('#dialog-body form'),generation=s.generation;await update();expect(getSnapshot().generation).toBeGreaterThan(generation);expect(form.textContent).toContain('原话 0');await form.onsubmit(new dom.window.Event('submit',{cancelable:true}));expect(form.textContent).toContain('依据已变化');expect(form.textContent).toContain('原话 4');
 d.getElementById('close-dialog').click();getSnapshot().closedLoop.sourceHash='b'.repeat(64);getSnapshot().diagnosisStatus='stale';await update();expect(d.getElementById('review-round').disabled).toBe(true);
 d.getElementById('round-map').click();expect(d.getElementById('review-round').disabled).toBe(true);
 }finally{dom.window.close();}
});
it('new condition or feedback material does not block same-source reading, while old judgments stay explicitly pending',async()=>{
 const {dom,d,current,getSnapshot,update}=await readabilityDom();try{const s=getSnapshot();s.diagnosisStatus='stale';s.closedLoop={sourceHash:current.source.hash,criteria:[],confirmationMapping:{applicable:true},nextAction:'按当前材料重新分析主线'};await update();expect(d.getElementById('review-round').disabled).toBe(false);d.getElementById('review-round').click();const body=d.getElementById('dialog-body');expect(body.textContent).toContain('判断与建议待更新');[...body.querySelectorAll('button')].find((b:any)=>b.textContent==='4 剩余差距')!.click();expect(body.textContent).toContain('上版整体判断');[...body.querySelectorAll('button')].find((b:any)=>b.textContent==='5 下一行动')!.click();expect(body.textContent).toContain('按当前材料重新分析主线');}finally{dom.window.close();}
});
it('five raw reading answers saved by the workbench reach the HTTP analyzer input and survive reopening',async()=>{
 const {config,analyzer}=await fixture();let service=new HumanGoalService(config,analyzer),app:any,dom:any;try{
 service.feedback('test',{expectedGeneration:0,idempotencyKey:'guided-http-goal',originalText:'SYNTHETIC reader goal',kind:'desired-change',author:'SYNTHETIC',provenance:'test',clauses:[{id:'trace',text:'SYNTHETIC check source',importance:'core'}]});await service.idle();app=await startServer(service,0);
 dom=new JSDOM(await readFile('src/human-goal-workbench/index.html','utf8'),{url:app.url,runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,d=w.document;w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.setInterval=()=>1;w.HTMLElement.prototype.getBoundingClientRect=()=>({width:860,height:420,x:0,y:0,top:0,left:0,right:860,bottom:420});
 w.fetch=(url:string,options:any)=>fetch(app.url+url,{...options,headers:{...options?.headers,Origin:app.url}});w.eval(await readFile('src/human-goal-workbench/client.js','utf8'));await new Promise(r=>setTimeout(r,50));d.getElementById('review-round').click();
 const answers=['SYNTHETIC own goal','SYNTHETIC cannot identify round value','SYNTHETIC no round receipt','SYNTHETIC uncertain understanding','SYNTHETIC observe one real reader'];for(const answer of answers){d.getElementById('reader-answer').value=answer;d.getElementById('reader-next').click();}await d.querySelector('#dialog-body form').onsubmit(new w.Event('submit',{cancelable:true}));await service.idle();
 const saved=service.read('test'),feedback=saved.feedback.at(-1)!;for(const answer of answers)expect(feedback.originalText).toContain(answer);expect(feedback.goalReview).toMatchObject({decision:'unknown',nextObservation:answers[4]});expect(saved.attempts.at(-1)!.input.feedback.at(-1)?.id).toBe(feedback.id);expect((await (await fetch(app.url+'/api/projects/test/state')).json() as any).goalReviews.acceptance).toBe(false);
 await app.close();await service.close();service=new HumanGoalService(config,analyzer);app=await startServer(service,0);const reopened:any=await (await fetch(app.url+'/api/projects/test/state')).json();expect(reopened.feedback.at(-1).originalText).toBe(feedback.originalText);expect(reopened.goalReviews.clauses[0]).toMatchObject({decision:'unknown',nextObservation:answers[4],status:'current'});
 }finally{dom?.window.close();if(app)await app.close();await service.close();}
});

it('default goal review HTTP save reaches analyzer and survives public-state and server reopen without product acceptance',async()=>{
 const {config,analyzer}=await fixture();let service=new HumanGoalService(config,analyzer),app:any;try{
 service.feedback('test',{expectedGeneration:0,idempotencyKey:'http-review-goal',originalText:'Observe goal realization',kind:'desired-change',author:'SYNTHETIC',provenance:'test',clauses:[{id:'trace',text:'Preserve source refs',importance:'core'}]});await service.idle();const old=service.read('test'),v=old.views[old.currentView!],g=old.goals.at(-1)!;app=await startServer(service,0);
 const q={expectedGeneration:old.generation,idempotencyKey:'http-bounded-review',originalText:'SYNTHETIC observed result remains uncertain',kind:'evidence-contribution',author:'SYNTHETIC actual HTTP caller',provenance:'test boundary, not human business acceptance',goalReview:{clauseId:'trace',goalHash:g.hash,sourceHash:v.source.hash,analysisAttemptId:v.attemptId,decision:'unknown',nextObservation:'Read actual source and evidence'}};
 const response=await fetch(app.url+'/api/projects/test/feedback',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url},body:JSON.stringify(q)});expect(response.status).toBe(200);const saved:any=await response.json();expect(saved.job.attemptId).toBeTruthy();await service.idle();const state:any=await (await fetch(app.url+'/api/projects/test/state')).json();expect(state.goalReviews.clauses[0]).toMatchObject({status:'current',decision:'unknown',originalText:q.originalText,continuity:'unchanged-mapping'});expect(state.goalReviews.acceptance).toBe(false);expect(state.closedLoop.status).not.toBe('verified');expect(service.read('test').attempts.at(-1)!.input.feedback.at(-1)?.goalReview).toEqual(q.goalReview);
 await app.close();service=new HumanGoalService(config,analyzer);app=await startServer(service,0);const reopened:any=await (await fetch(app.url+'/api/projects/test/state')).json();expect(reopened.goalReviews).toEqual(state.goalReviews);expect(reopened.goals).toEqual(state.goals);
 }finally{if(app)await app.close();await service.close();}
});
