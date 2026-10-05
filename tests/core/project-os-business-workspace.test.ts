import {afterEach,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(done=>done()));
// These are public API projections, not model/runtime evidence. The tests check
// how the real browser client consumes them; original-case proof is separate.
function projection(){
 const labels=['可靠的项目理解','人类目标的核对与分解','实际运行的验证','每轮开发的连续追踪','从整体出发的调整建议'];
 const goal={id:'goal-5',version:5,hash:'a'.repeat(64),originalText:'完整业务目标：理解代码、核对期望、实际验证、持续追踪和整体调整。',clauses:labels.map((text,i)=>({id:`c${i}`,text:`${text}：保留完整的用户结果。`,importance:'core',constraints:[],examples:[]}))};
 const source={hash:'b'.repeat(64),files:[],inventory:[],suppliedBytes:0,totalBytes:0,partial:false,runtime:'API projection fixture',omitted:[]};
 const module={id:'module',title:'代码模块',kind:'discovered',responsibility:'来源绑定的工作台',inputs:['人的目标'],outputs:['可核查结果'],refs:[],supersedes:[]};
 const workflow={status:'established',coverage:'registered-scope',summary:'Fixture journeys',unknowns:[],journeys:goal.clauses.map((c,i)=>({id:`journey-${i}`,title:`流程 ${i+1}`,purpose:c.text,clauseIds:[c.id],observed:{steps:[{id:`step-${i}`,title:'核对结果',purpose:c.text,actor:'用户',responsibility:'核对',inputs:['目标'],outputs:['意见'],actual:'Fixture step',state:'source-supported',targetIds:['module'],clauseIds:[c.id],refs:[],uncertainty:'Runtime unknown'}],links:[]},desired:{steps:[],links:[]}}))};
 const diagnosis={scope:'workflow',scopeReason:'先检查跨模块主线',certainty:'supported-hypothesis',conclusion:'整体主线已有实现，完整用户结果需要逐项核对。',journeys:[],evidence:[],counterEvidence:[],alternatives:[],taskAssessment:{reason:'Fixture',remaining:'独立理解未知'},recommendation:{action:'先按完整目标检查主线',reason:'优先解决整体阻断',verificationJourney:'沿完整目标核对',options:[],targetIds:['module'],clauseIds:goal.clauses.map(c=>c.id),journeyIds:workflow.journeys.map(j=>j.id)}};
 const gaps=goal.clauses.map((c,i)=>({id:`gap-${i}`,rank:i+1,lifecycle:'open',clauseIds:[c.id],targetIds:['module'],expected:`目标 ${i+1} 的用户效果尚需核对`,actual:'Unknown',action:'保存真实反例',kind:'missing-evidence',certainty:'unknown',refs:[],counterEvidence:[],causeHypotheses:[],uncertainty:'Unknown',nextObservation:'查看完整旅程',actionKind:'investigate',prerequisites:[],expectedOutcome:'可判断',verificationPlan:'实际观察',unblocksClauseIds:[],effort:'unknown',risk:'unknown'}));
 const view={attemptId:'analysis',generation:1,source,goal,analysis:{purpose:'项目帮助用户把完整目标与实际开发结果对照。',purposeRefs:[],modules:[module],edges:[],alignments:goal.clauses.map(c=>({id:`align-${c.id}`,clauseIds:[c.id],targetIds:['module'],status:'implemented-unverified',rationale:'Fixture mapping',refs:[]})),workflow,diagnosis,coverageNotes:'Fixture',limitations:[],conflicts:[],feedbackResponse:'Fixture'},gaps,statuses:{module:'implemented-unverified'}};
 const round={id:'round',purpose:'修复一个局部恢复问题',goalHash:goal.hash,clauseIds:['c3'],status:'completed',stale:false,viewAttemptId:'analysis',after:{sourceHash:source.hash,inventory:[],id:'after'},before:{sourceHash:source.hash,inventory:[],coverage:['main.ts'],id:'before'},deltas:[],feedbackIds:[],mode:'live',attempts:[],pending:[],conditionVerified:[],eventCount:0,verified:[],touchedTargets:[],mapping:'Fixture',remaining:'其他目标还待核对',next:'局部建议'};
 const delivery={title:'局部恢复修好了',goalConnection:'连续追踪',before:'Fixture before',after:'Fixture after',evidenceSummary:'窄范围检查',receiptIds:[],observationIds:[],remaining:'完整目标仍待核对',nextAction:'旧局部行动',nextCheck:'旧局部方法',author:'fixture',current:true,sourceCurrent:true};
 const criteria=goal.clauses.map(c=>({criterionId:`condition-${c.id}`,text:'限定技术检查',observable:'Fixture output',clauseIds:[c.id],targetIds:['module'],journeyIds:[`journey-${c.id.slice(1)}`],status:'passed',mapping:'mapped',evidence:[]}));
 return {projectId:'self',generation:1,goals:[goal],views:[view],currentView:0,attempts:[],feedback:[],actions:[],observations:[],conflicts:[],expectations:[],scenarioSets:[],roundAnalysis:{jobs:[]},diagnosisStatus:'published',rounds:{revision:1,rounds:[round],registrations:[],policy:{}},mainline:{revision:1,status:'current',sourceHash:source.hash,viewAttemptId:'analysis',journeys:[],rounds:[{roundId:'round',status:'verified-scoped',delivery,mapping:{state:'confirmed'},steps:[],intentSteps:[],candidates:[],goalClauses:goal.clauses.map(c=>c.text),remainingGaps:[],remaining:'完整目标仍待核对',reported:'Fixture report',nextVerification:'核对实际结果'}]},activity:{revision:1,connections:[],turns:[],events:[]},goalReviews:{clauses:goal.clauses.map(c=>({clauseId:c.id,status:'current',decision:'unknown'}))},closedLoop:{sourceHash:source.hash,status:'verified',diagnosisStale:false,confirmation:null,confirmationMapping:{applicable:true,status:'same-analysis'},criteria,receipts:[],gapProgress:[],runtimeCalls:[],priorityReason:'检查整体目标',nextAction:'先按完整目标检查主线',nextActionDetails:{kind:'diagnosis',text:'先按完整目标检查主线',reason:'优先解决整体阻断',nextCheck:'沿完整目标核对',goalHash:goal.hash,sourceHash:source.hash}}};
}
async function browser(initial=projection()){
 let current=initial;const assets=process.env.PROJECT_OS_WORKBENCH_BASELINE||join(process.cwd(),'src/human-goal-workbench');
 const dom=new JSDOM(readFileSync(join(assets,'index.html'),'utf8'),{url:'http://127.0.0.1:12345/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;cleanup.push(()=>w.close());
 w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(url:string)=>({ok:true,json:async()=>url==='/api/projects'?{projects:[{id:'self',label:'完整业务案例',sourceKind:'working-tree',scope:['main.ts']}]}:structuredClone(current)});
 w.eval(readFileSync(join(assets,'client.js'),'utf8'));await w.eval('refresh(true)');await new Promise(r=>setTimeout(r,20));
 w.eval('render()');expect(w.document.getElementById('notice')?.textContent).toBe('');return {w,document:w.document,update:async(next:typeof initial)=>{current=next;await w.eval('refresh(true)');}};
}
it('a recent local delivery cannot replace the whole goal and overall judgment',async()=>{
 const {document:d}=await browser();const host=d.getElementById('overall-diagnosis')!;
 expect(host.querySelector('.definition')?.textContent).toContain('整体业务目标');
 expect(host.querySelector('.definition')?.textContent).toContain('可靠的项目理解');
 expect(host.textContent).toContain('整体主线已有实现');
 expect(d.querySelector('#latest-delivery')?.open).toBe(false);
 expect(d.querySelector('#latest-delivery')?.textContent).toContain('局部恢复修好了');
});
it('starts with all business goals and keeps limited green checks separate from user outcomes',async()=>{
 const {document:d}=await browser();expect(d.getElementById('tab-goals')?.getAttribute('aria-selected')).toBe('true');
 expect(d.querySelectorAll('.business-goal')).toHaveLength(5);expect(d.querySelectorAll('.business-path button')).toHaveLength(5);
 const card=d.querySelector('.business-goal')!;expect(card.textContent).toContain('1/1 项限定条件通过');expect(card.textContent).toContain('业务效果待核对');
 expect(d.getElementById('map-workspace')?.hidden).toBe(true);
});
it('withdraws old condition success for changed goals or source and retains candidate explanations',async()=>{
 const initial=projection(),{document:d,update}=await browser(initial),changed=structuredClone(initial);
 changed.goals[0]={...changed.goals[0],hash:'c'.repeat(64),version:6};changed.closedLoop.sourceHash='d'.repeat(64);changed.diagnosisStatus='stale';
 await update(changed);expect(d.querySelectorAll('.business-goal[data-source-current="false"]')).toHaveLength(5);
 expect(d.querySelector('.business-goal')?.textContent).toContain('没有当前适用的条件证明');
 expect(d.querySelector('.business-goal')?.textContent).not.toContain('1/1 项限定条件通过');
 expect(d.querySelector('.business-goal')?.textContent).toContain('上版候选');
});
it('goal review, source workflow and keyboard navigation share the same chosen goal',async()=>{
 const {w,document:d}=await browser();const card=d.querySelector('.business-goal[data-business-clause-id="c2"]')!;
 const review=[...card.querySelectorAll('button')].find((b:any)=>b.textContent==='核对目标与模块') as any;review.click();
 expect(d.querySelector('.goal-review-card[data-clause-id="c2"]')?.open).toBe(true);expect(d.querySelector('.goal-review-card[data-clause-id="c0"]')?.open).toBe(false);
 d.getElementById('close-dialog')!.click();([...card.querySelectorAll('button')].find((b:any)=>b.textContent==='看流程 · 流程 3') as any).click();
 expect(d.getElementById('tab-map')!.getAttribute('aria-selected')).toBe('true');expect(d.querySelector('#workflow-journey')?.value).toBe('journey-2');
 d.getElementById('tab-map')!.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
 expect(d.getElementById('tab-goals')!.getAttribute('aria-selected')).toBe('true');expect(d.getElementById('goals-workspace')!.hidden).toBe(false);
});
