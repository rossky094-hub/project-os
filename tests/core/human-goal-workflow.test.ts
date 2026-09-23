import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSource, readSource } from '../../src/core/human-goal-workflow/source.js';
import { digest, type Project } from '../../src/core/human-goal-workflow/types.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hg-SYNTHETIC-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function project(): Promise<Project> {
  const sourceRoot = join(root, 'source'); await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'main.py'), 'from engine import run\ndef main():\n    return run()\n');
  await writeFile(join(sourceRoot, 'engine.py'), 'def run():\n    return 42\n');
  return { id: 'synthetic', label: 'SYNTHETIC Python', sourceRoot, scope: ['.'], revision: 'synthetic-fixture', sourceKind: 'snapshot', subjectId: 'synthetic', caseRole: 'positive-subject' };
}
it('discovers real file hashes, imports, symbols; bounds supplied lines and rejects escapes', async () => {
  const p = await project(); const source = discoverSource(p, { maxFiles: 1 });
  expect(source.files).toHaveLength(1); expect(source.partial).toBe(true); expect(source.omitted.length).toBeGreaterThan(0);
  expect(source.files[0].sha256).toBe(digest(await readFile(join(p.sourceRoot, source.files[0].path))));
  expect(() => readSource(p, '../outside')).toThrow();
  await symlink(join(root, 'outside'), join(p.sourceRoot, 'escape.py'));
  expect(() => readSource(p, 'escape.py')).toThrow();
  const complete = discoverSource(p); expect(complete.relationships.some(r => r.to === 'engine.py')).toBe(true);
});
import { HumanGoalService, targetStatus, projectView } from '../../src/core/human-goal-workflow/service.js';
import { validateAnalysis, providerAnalysisSchema, CodexAnalyzer, makePrompt } from '../../src/core/human-goal-workflow/analyzer.js';
import { SessionStore } from '../../src/core/human-goal-workflow/store.js';
import { type AnalysisInput, type Analysis, type Analyzer, type Attempt } from '../../src/core/human-goal-workflow/types.js';
function model(input:AnalysisInput):Analysis {
  const f=input.source.files[0],ref={path:f.path,sha256:f.sha256,start:f.ranges[0].start,end:f.ranges[0].start};
  const clauses=input.goal?.clauses??[];
  return {purpose:`SYNTHETIC ${f.path} purpose`,purposeRefs:[ref],limitations:['Injected deterministic test only'],modules:[{id:'module-a',title:'Source reader',kind:'discovered',responsibility:'Reads source',inputs:['path'],outputs:['value'],refs:[ref],supersedes:[]},{id:'module-b',title:'Consumer',kind:'discovered',responsibility:'Consumes value',inputs:['value'],outputs:['result'],refs:[ref],supersedes:[]}],edges:[{id:'edge-a-b',from:'module-a',to:'module-b',label:'value transfer',expected:'preserve value',actual:'only static evidence',refs:[ref]}],alignments:clauses.map(c=>({id:`alignment-${c.id}`,clauseIds:[c.id],targetIds:['module-a','module-b','edge-a-b'],status:'implemented-unverified',rationale:'Source only',refs:[ref]})),gaps:clauses.map(c=>({id:`gap-${c.id}`,clauseIds:[c.id],targetIds:['edge-a-b'],kind:'missing-evidence',expected:c.text,actual:'No runtime proof',certainty:'unknown',refs:[ref],counterEvidence:[],causeHypotheses:['producer may drop data','consumer may ignore data'],uncertainty:'No boundary observation',nextObservation:'Record input and output at boundary',action:'Observe edge',actionKind:'investigate',prerequisites:['authorized executor'],expectedOutcome:'Distinguish competing hypotheses',verificationPlan:'Compare expected and actual value',unblocksClauseIds:[],effort:'unknown',risk:'unknown'})),conflicts:[],changes:[],coverageNotes:'SYNTHETIC source scope only',feedbackResponse:input.feedback.length?'Fresh check using original feedback and source':'Initial source check'};
}
const goal=(generation:number,text='preserve values',id='c1',key='goal-request')=>({expectedGeneration:generation,idempotencyKey:key,originalText:text,kind:'desired-change',targetIds:[],author:'SYNTHETIC fixture author',provenance:'authored deterministic test',clauses:[{id,text,importance:'core'}]});
async function fixture(analyzer?:Analyzer){const p=await project();const calls:AnalysisInput[]=[];const injected=analyzer??{revision:'SYNTHETIC-test-v1',async analyze(input:AnalysisInput){calls.push(structuredClone(input));return model(input);}};const config={projects:[p],dataDir:join(root,'data'),analyzer:{command:'never-real-model',timeoutMs:5000,maxAttempts:2}};return {p,calls,config,service:new HumanGoalService(config,injected)};}
it('samples late public signatures and parses Python relative imports without increasing context budget',async()=>{
 const p=await project();await mkdir(join(p.sourceRoot,'pkg/core'),{recursive:true});await writeFile(join(p.sourceRoot,'pkg/core/contracts.py'),'class Contract:\n    pass\n');await writeFile(join(p.sourceRoot,'pkg/projection.py'),'def render():\n    pass\n');
 await writeFile(join(p.sourceRoot,'pkg/service.py'),'from .core.contracts import Contract\nfrom .projection import render\n'+Array.from({length:70},(_,i)=>`def early_${i}():\n    return "${'x'.repeat(100)}"`).join('\n')+'\n'+Array(300).fill('# long early body').join('\n')+'\ndef late_reopen():\n    return render()\n');
 const source=discoverSource(p,{perFileBytes:1800}),f=source.files.find(f=>f.path==='pkg/service.py')!;expect(f.excerpt).toContain('def late_reopen');expect(f.ranges.some(r=>r.start>300)).toBe(true);expect(source.suppliedBytes).toBeLessThanOrEqual(350000);expect(source.relationships).toEqual(expect.arrayContaining([expect.objectContaining({from:'pkg/service.py',to:'pkg/core/contracts.py'}),expect.objectContaining({from:'pkg/service.py',to:'pkg/projection.py'})]));
});
it('the same scanner discriminates TS and Python inputs, prioritizes purpose, and rejects snapshot tampering',async()=>{
 const p=await project();const first=discoverSource(p);await writeFile(join(p.sourceRoot,'README.md'),'Project purpose\n');await writeFile(join(p.sourceRoot,'entry.ts'),"import { run } from './worker.js';\nexport function execute() { return run(); }\n");await writeFile(join(p.sourceRoot,'worker.ts'),'export function run() { return 1; }\n');const second=discoverSource(p);expect(second.files[0].path).toBe('README.md');expect(second.hash).not.toBe(first.hash);expect(second.relationships.some(r=>r.to==='worker.ts')).toBe(true);
 const manifest=join(root,'manifest.json');await writeFile(manifest,JSON.stringify({files:{'main.py':'0'.repeat(64)}}));expect(()=>discoverSource({...p,snapshotManifest:manifest})).toThrow('快照字节不符');
});
it('whole and module feedback create new source reads and independent immutable human/analysis versions',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();let s=service.read('synthetic');expect(s.views).toHaveLength(1);expect(calls).toHaveLength(1);const oldGoal=JSON.stringify(s.goals[0]),oldView=JSON.stringify(s.views[0]);
 service.feedback('synthetic',{expectedGeneration:s.generation,idempotencyKey:'module-review',originalText:'This is interpretation correction; do not develop an extra feature',kind:'interpretation-correction',targetIds:['module-a'],author:'SYNTHETIC',provenance:'test'});await service.idle();s=service.read('synthetic');expect(calls).toHaveLength(2);expect(calls[1].previous).toEqual(calls[0]&&s.views[0].analysis);expect(calls[1].feedback.at(-1)?.originalText).toContain('do not develop');expect(calls[1].inputHash).not.toBe(calls[0].inputHash);expect(await readFile(join(s.attempts[1].rawDir,'source-read.json'),'utf8')).toContain('main.py');expect(JSON.stringify(s.goals[0])).toBe(oldGoal);expect(JSON.stringify(s.views[0])).toBe(oldView);expect(s.goals).toHaveLength(1);expect(makePrompt(calls[1])).toContain('不可信证据');}finally{await service.close();}
});
it('idempotency protects payload, stale generation retains conflict text, and goal-only edits never overwrite analysis',async()=>{
 const {service}=await fixture();try{const req={...goal(0),analyze:false};const a=service.feedback('synthetic',req);expect(service.feedback('synthetic',req)).toEqual(a);expect(()=>service.feedback('synthetic',{...req,originalText:'different'})).toThrow('请求键');expect(()=>service.feedback('synthetic',{...goal(0,'stale original','c1','new-key'),analyze:false})).toThrow('原文已保留');const s=service.read('synthetic');expect(s.conflicts[0].request).toMatchObject({originalText:'stale original'});expect(s.goals).toHaveLength(1);expect(s.views).toHaveLength(0);}finally{await service.close();}
});
it('ungrounded line/hash/join references and fabricated verified state fail; missing clauses create proposed capability',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();const input=calls[0];const a=model(input);a.purposeRefs[0].end=999999;expect(()=>validateAnalysis(a,input)).toThrow('未提供');const b=model(input);b.edges[0].to='invented';expect(()=>validateAnalysis(b,input)).toThrow();const c:any=model(input);c.alignments[0].status='verified-aligned';expect(()=>validateAnalysis(c,input)).toThrow();const d=model(input);d.alignments=[];const result=validateAnalysis(d,input);expect(result.modules.some(m=>m.kind==='proposed')).toBe(true);expect(result.alignments.some(a=>a.clauseIds.includes('c1')&&a.status==='unknown')).toBe(true);
 const windowed=structuredClone(input);windowed.source.files[0].ranges=[{start:1,end:1},{start:4,end:4}];const crossing=model(windowed);crossing.purposeRefs[0]={...crossing.purposeRefs[0],start:1,end:4};expect(()=>validateAnalysis(crossing,windowed)).toThrow('未提供');}finally{await service.close();}
});
it('late completed result stays historical and never overwrites a newer human goal',async()=>{
 let release!:(value:unknown)=>void;const {service}=await fixture({revision:'delayed-synthetic',analyze:input=>new Promise(resolve=>{release=()=>resolve(model(input));})});try{service.feedback('synthetic',goal(0));await new Promise(r=>setTimeout(r,10));let s=service.read('synthetic');service.feedback('synthetic',{...goal(s.generation,'new human goal','c1','new-goal'),analyze:false});release(null);await service.idle();s=service.read('synthetic');expect(s.goals.at(-1)?.originalText).toBe('new human goal');expect(s.currentView).toBeNull();expect(s.attempts[0].result).toBeDefined();expect(s.attempts[0].promoted).toBe(false);expect(s.attempts[0].error).toContain('STALE_RESULT');}finally{await service.close();}
});
it('failed attempt explicit retry retains exact input and carried budget, and new instance reopens durable view',async()=>{
 let count=0;const analyzer:Analyzer={revision:'failing-synthetic',async analyze(input){if(count++===0)throw new Error('transient test failure');return model(input);}};const {service,config}=await fixture(analyzer);service.feedback('synthetic',goal(0));await service.idle();let s=service.read('synthetic');expect(s.attempts[0].state).toBe('failed');service.retry('synthetic',{expectedGeneration:s.generation,idempotencyKey:'retry-1',attemptId:s.attempts[0].id,recoveryBasis:'SYNTHETIC transient executor recovered'});await service.idle();s=service.read('synthetic');expect(s.attempts[1].input).toEqual(s.attempts[0].input);expect(s.attempts[1].usedMs).toBeGreaterThanOrEqual(s.attempts[0].usedMs);expect(s.attempts[1].parentAttemptId).toBe(s.attempts[0].id);expect(s.views).toHaveLength(1);await service.close();const reopened=new HumanGoalService(config,analyzer);try{expect(reopened.read('synthetic')).toEqual(s);}finally{await reopened.close();}
});
it('exclusive process lease refuses second writer; orphan active state becomes interrupted; malformed pointer fails closed',async()=>{
 const {service,config}=await fixture();expect(()=>new HumanGoalService(config)).toThrow('租约');service.feedback('synthetic',{...goal(0),analyze:false});const s=service.read('synthetic');s.attempts.push({id:'orphan',parentAttemptId:null,state:'running',input:{} as AnalysisInput,createdAt:new Date().toISOString(),usedMs:0,totalBudgetMs:5000,attemptNumber:1,promoted:false,rawDir:root});service.store.save(s);await service.close();const reopened=new HumanGoalService(config);expect(reopened.read('synthetic').attempts[0].state).toBe('interrupted');await reopened.close();await writeFile(join(config.dataDir,'sessions/synthetic/current.json'),'invalid');const store=new SessionStore(config.dataDir);try{expect(()=>store.load('synthetic')).toThrow('状态损坏');}finally{store.close();}
});
it('mixed classifications and explicit replacements persist while parent conflicts remain visible',async()=>{
 const {service}=await fixture({revision:'conflict-test',async analyze(input){const a=model(input);if(input.expectations.length)a.conflicts=[{targetId:'module-a',clauseIds:['c1'],parentText:'preserve values',moduleText:'discard input',reason:'conflicting output contract'}];return a;}});try{service.feedback('synthetic',goal(0));await service.idle();const goalHash=service.read('synthetic').goals[0].hash;for(const [index,kind]of ['interpretation-correction','evidence-contribution','desired-change'].entries()){const s=service.read('synthetic');service.feedback('synthetic',{expectedGeneration:s.generation,idempotencyKey:`mixed-${index}`,originalText:'SYNTHETIC same original mixed sentence',kind,targetIds:['module-a'],author:'SYNTHETIC',provenance:'test split',analyze:index===2,...(index===2?{expectation:{targetId:'module-a',responsibility:'discard input',inputs:[],outputs:[],examples:[],clauseIds:['c1'],disposition:'required',replaces:['module-b']}}:{})});}await service.idle();const s=service.read('synthetic');expect(s.feedback.slice(-3).map(f=>f.kind)).toEqual(['interpretation-correction','evidence-contribution','desired-change']);expect(s.goals[0].hash).toBe(goalHash);expect(s.views.at(-1)?.analysis.conflicts).toHaveLength(1);expect(s.expectations[0].replaces).toEqual(['module-b']);}finally{await service.close();}
});
it('node pass cannot prove edge pass; unmatched imported evidence stays unqualified; goal shrink is not resolved',async()=>{
 const {service}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();let s=service.read('synthetic'),v=s.views[0];const o={id:'node-observation',sourceHash:v.source.hash,goalHash:v.goal!.hash,producer:'SYNTHETIC',targetIds:['module-a','module-b'],clauseIds:['c1'],rawRecord:'synthetic retained execution',rawHash:digest('synthetic retained execution'),result:'passed' as const,qualified:true,qualificationReason:'test injected qualified boundary',invocation:{},createdAt:new Date().toISOString()};expect(targetStatus(v,[o],'module-a')).toBe('verified-aligned');expect(targetStatus(v,[o],'edge-a-b')).not.toBe('verified-aligned');expect(targetStatus(v,[{...o,targetIds:['edge-a-b'],result:'failed'}],'edge-a-b')).toBe('verified-mismatch');
 service.observe('synthetic',{expectedGeneration:s.generation,idempotencyKey:'unknown-proof',producer:'untrusted',sourceHash:v.source.hash,goalHash:v.goal!.hash,targetIds:['edge-a-b'],clauseIds:['c1'],rawRecord:'{"passed":true}',rawHash:digest('{"passed":true}'),result:'passed'});s=service.read('synthetic');expect(s.observations[0].qualified).toBe(false);expect(targetStatus(v,s.observations,'edge-a-b')).not.toBe('verified-aligned');
 service.feedback('synthetic',goal(s.generation,'different goal','c2','shrink'));await service.idle();const old=service.read('synthetic').views.at(-1)!.gaps.find(g=>g.id==='gap-c1');expect(old?.lifecycle).toBe('scope-changed');}finally{await service.close();}
});
it('ranking responds to human hard constraints and retractions require source evidence',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',{...goal(0),clauses:[{id:'c1',text:'first',importance:'optional'},{id:'c2',text:'second',importance:'hard-constraint'}]});await service.idle();let s=service.read('synthetic');expect(s.views[0].gaps[0].id).toBe('gap-c2');service.feedback('synthetic',{...goal(s.generation,'priorities changed','c1','rerank'),clauses:[{id:'c1',text:'first',importance:'hard-constraint'},{id:'c2',text:'second',importance:'optional'}]});await service.idle();s=service.read('synthetic');expect(s.views.at(-1)!.gaps[0].id).toBe('gap-c1');expect(s.views.at(-1)!.changes.ranking).toContain('gap-c2');const a=model(calls[1]);a.changes=[{gapId:'gap-c2',disposition:'retracted',reason:'corrected',refs:[]}];expect(()=>validateAnalysis(a,calls[1])).toThrow('撤回');}finally{await service.close();}
});
it('real adapter failure retains request/config/argv/raw records and never substitutes semantic output',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();const dir=join(root,'adapter');const adapter=new CodexAnalyzer({command:join(root,'nonexistent-codex'),timeoutMs:1000,maxAttempts:1});await expect(adapter.analyze(calls[0],dir,new AbortController().signal,1000)).rejects.toThrow('Codex 分析失败');const record=JSON.parse(await readFile(join(dir,'invocation.json'),'utf8'));expect(record.transport).toMatchObject({schemaVersion:'project-os.analysis-input-transport.v1',originalInputSha256:digest(JSON.stringify(calls[0])),reconstructionVerified:true,maxChars:CODEX_INPUT_MAX_CHARS});expect(record.transport.transportHash).toBe(digest(JSON.stringify(projectInputTransport(calls[0]))));expect(record.argv).toContain('read-only');expect(record.argv).not.toContain('-m');expect(record.cwd).not.toBe(calls[0].project.sourceRoot);expect(JSON.parse(await readFile(join(dir,'receipt.json'),'utf8')).code).toBeNull();expect(await readFile(join(dir,'request.txt'),'utf8')).toContain(calls[0].inputHash);}finally{await service.close();}
});

import { vi } from 'vitest';
import { z } from 'zod';
import { outputSchema, jsonSchema } from '../../src/core/human-goal-workflow/analyzer.js';
import { configSchema, analysisSchema, hash } from '../../src/core/human-goal-workflow/types.js';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';

it('wire preserves safe IDs, source SHA, text and array limits and numeric bounds without relaxing admission',async()=>{
 const wire=outputSchema.properties,mod=wire.modules.items.properties,ref=mod.refs.items.properties;
 expect(mod.id.pattern).toBe('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$');
 expect(ref.sha256.pattern).toBe('^[a-f0-9]{64}$');
 expect(mod.title).toEqual({type:'string',minLength:1,maxLength:12000});
 expect(ref.start).toEqual({type:'integer',minimum:1});expect(ref.end).toEqual(ref.start);expect(JSON.stringify(outputSchema)).not.toContain('allOf');
 expect(wire.modules).toMatchObject({minItems:1,maxItems:150});expect(mod.refs.maxItems).toBe(100);
 expect(wire.alignments.items.properties.targetIds).toMatchObject({maxItems:200,items:{pattern:mod.id.pattern}});
 expect(wire.edges.items.properties.from.pattern).toBe(mod.id.pattern);
 expect(jsonSchema(z.number().min(-1).max(4.5))).toEqual({type:'number',minimum:-1,maximum:4.5});
 expect(jsonSchema(z.number().gt(2).lt(9))).toEqual({type:'number',exclusiveMinimum:2,exclusiveMaximum:9});
 expect(jsonSchema(z.array(z.string().min(2)).length(3))).toEqual({type:'array',items:{type:'string',minLength:2},minItems:3,maxItems:3});
 expect(()=>jsonSchema(z.string().email())).toThrow('unsupported');
 const {service,calls}=await fixture();try{
  service.feedback('synthetic',goal(0));await service.idle();const input=calls[0],valid=model(input);
  expect(validateAnalysis(valid,input)).toEqual(valid);
  const bad=model(input);bad.modules[0].id='src/world_model/core/sources.py';
  expect(new RegExp(mod.id.pattern).test(bad.modules[0].id)).toBe(false);
  expect(()=>analysisSchema.parse(bad)).toThrow();expect(()=>validateAnalysis(bad,input)).toThrow();
  expect(new RegExp(mod.id.pattern).test('core-sources')).toBe(true);
  expect(makePrompt(input)).toContain('ID 不是源路径');expect(makePrompt(input)).toContain('downstream-blocked');
 }finally{await service.close();}
});
it('UNKNOWN and blocked alignments yield visible grouped investigations with exact uncovered pairs and retained raw gaps',async()=>{
 const {service,calls}=await fixture({revision:'unknown-synthetic',async analyze(input){const a=model(input);a.alignments[0].status='unknown';a.gaps=[];return a;}});
 try{
  service.feedback('synthetic',{...goal(0),clauses:[{id:'c1',text:'first',importance:'core'},{id:'c2',text:'second',importance:'supporting'}]});await service.idle();
  const s=service.read('synthetic'),input=s.attempts[0].input,view=s.views[0];
  expect(view.gaps.some(g=>g.lifecycle==='open'&&g.actionKind==='investigate')).toBe(true);
  expect(JSON.parse(await readFile(join(s.attempts[0].rawDir,'returned-output.json'),'utf8')).gaps).toEqual([]);
  const a=model(input);a.alignments=[{...a.alignments[0],clauseIds:['c1','c2'],status:'unknown'}];a.gaps=[];
  const result=validateAnalysis(a,input);expect(result.gaps).toHaveLength(1);
  expect(result.gaps[0]).toMatchObject({clauseIds:['c1','c2'],targetIds:['edge-a-b','module-a','module-b'],kind:'missing-evidence',certainty:'unknown',actionKind:'investigate',refs:a.alignments[0].refs,causeHypotheses:[]});
  expect(result.gaps[0].actual).toContain('系统派生');expect(a.gaps).toEqual([]);
  const b=structuredClone(a);b.alignments[0].status='downstream-blocked';b.gaps=[model(input).gaps[0]];const original=structuredClone(b.gaps[0]);
  const projected=validateAnalysis(b,input);expect(projected.gaps).toHaveLength(3);expect(projected.gaps[0]).toEqual(original);
  const pairs=projected.gaps.flatMap(g=>g.clauseIds.flatMap(c=>g.targetIds.map(t=>`${c}:${t}`)));
  expect(pairs).toHaveLength(6);expect(new Set(pairs).size).toBe(6);
  expect(projected.gaps.slice(1).every(g=>g.nextObservation.includes('依赖传递'))).toBe(true);
  // A second, overlapping alignment neither invents pairs nor duplicates previous coverage.
  b.alignments.push({...b.alignments[0],id:'overlap',clauseIds:['c1'],targetIds:['module-a']});
  expect(validateAnalysis(b,input).gaps).toEqual(projected.gaps);
  const c=structuredClone(a);c.alignments[0].clauseIds=['c1'];c.alignments[0].targetIds=['module-a'];
  c.alignments.push({...c.alignments[0],id:'separate',clauseIds:['c2'],targetIds:['module-b']});
  const separate=validateAnalysis(c,input).gaps.flatMap(g=>g.clauseIds.flatMap(cid=>g.targetIds.map(t=>`${cid}:${t}`)));
  expect(separate.sort()).toEqual(['c1:module-a','c2:module-b']);
  // Model-owned IDs remain untouched even if they collide with the deterministic fallback ID.
  const collision=structuredClone(a);collision.gaps=[{...original,id:result.gaps[0].id}];
  const resolved=validateAnalysis(collision,input);const ids=[...resolved.modules,...resolved.edges,...resolved.alignments,...resolved.gaps].map(x=>x.id);
  expect(new Set(ids).size).toBe(ids.length);expect(resolved.gaps[0]).toEqual(collision.gaps[0]);
 }finally{await service.close();}
});
it('no-deadline is opt-in, passes null, carries elapsed time on explicit recovery and still limits attempts',async()=>{
 const p=await project(),limits:(number|null)[]=[];
 const config={projects:[p],dataDir:join(root,'unlimited'),analyzer:{command:'not-executed',timeoutMs:null,maxAttempts:2}};
 expect(configSchema.parse({projects:[p],dataDir:root}).analyzer.timeoutMs).toBe(240000);
 expect(configSchema.parse(config).analyzer.timeoutMs).toBeNull();
 expect(()=>configSchema.parse({...config,analyzer:{timeoutMs:0}})).toThrow();
 let count=0;const analyzer:Analyzer={revision:'unlimited-test',async analyze(_input,_dir,_signal,limit){limits.push(limit);count++;await new Promise(r=>setTimeout(r,5));throw new Error('synthetic failure');}};
 const service=new HumanGoalService(config,analyzer);
 try{
  service.feedback(p.id,goal(0));await service.idle();let s=service.read(p.id),first=structuredClone(s.attempts[0]);
  expect(count).toBe(1);expect(first.totalBudgetMs).toBeNull();expect(first.usedMs).toBeGreaterThan(0);expect(first.startedAt).toBeDefined();
  service.retry(p.id,{expectedGeneration:s.generation,idempotencyKey:'explicit',attemptId:first.id,recoveryBasis:'fixture executor repaired'});await service.idle();s=service.read(p.id);
  expect(limits).toEqual([null,null]);expect(s.attempts[0]).toEqual(first);expect(s.attempts[1].input).toEqual(first.input);
  expect(s.attempts[1].usedMs).toBeGreaterThan(first.usedMs);expect(s.attempts[1].totalBudgetMs).toBeNull();
  expect(()=>service.retry(p.id,{expectedGeneration:s.generation,idempotencyKey:'too-many',attemptId:s.attempts[1].id,recoveryBasis:'again'})).toThrow('尝试次数不足');
 }finally{await service.close();}
 const reopened=new HumanGoalService(config,analyzer);try{expect(reopened.read(p.id).attempts).toHaveLength(2);expect(count).toBe(2);}finally{await reopened.close();}
});
it('no-deadline running and queued cancellations stay interrupted and never promote late results',async()=>{
 const p=await project();let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});let count=0;
 const service=new HumanGoalService({projects:[p],dataDir:join(root,'cancel'),analyzer:{timeoutMs:null}},{revision:'cancel-test',analyze(input,_dir,signal,limit){count++;expect(limit).toBeNull();return new Promise(resolve=>{release=()=>resolve(model(input));signal.addEventListener('abort',release,{once:true});started();});}});
 try{
  service.feedback(p.id,goal(0));await ready;let s=service.read(p.id);const first=s.attempts[0];
  service.analyze(p.id,{expectedGeneration:s.generation,idempotencyKey:'queued'});s=service.read(p.id);service.cancel(p.id,s.attempts[1].id);service.cancel(p.id,first.id);await service.idle();s=service.read(p.id);
  expect(count).toBe(1);expect(s.attempts.map(a=>a.state)).toEqual(['interrupted','interrupted']);expect(s.currentView).toBeNull();expect(s.attempts[0].result).toBeDefined();
 }finally{release?.();await service.close();}
});
it('restart accounts no-deadline interruption conservatively, preserves immutable history and finite budget policy',async()=>{
 const {service,config}=await fixture();service.feedback('synthetic',{...goal(0),analyze:false});const s=service.read('synthetic');
 const base:Attempt={id:'unlimited-orphan',parentAttemptId:null,state:'running',input:{} as AnalysisInput,createdAt:'2026-09-15T00:00:00.000Z',startedAt:'2026-09-15T00:00:05.000Z',usedMs:200,totalBudgetMs:null,attemptNumber:2,promoted:false,rawDir:root};
 s.attempts=[base,{...base,id:'finite',totalBudgetMs:5000},{...base,id:'queued',state:'queued',startedAt:undefined}];service.store.save(s);
 const oldHash=hash(s),oldBytes=await readFile(join(config.dataDir,'sessions/synthetic',`${oldHash}.json`),'utf8');
 service.store.interruptActive('synthetic','2026-09-15T00:00:15.000Z');const recovered=service.read('synthetic');
 expect(recovered.attempts[0]).toMatchObject({state:'interrupted',totalBudgetMs:null,usedMs:10200,elapsedAccounting:'conservative-upper-bound'});
 expect(recovered.attempts[1].usedMs).toBe(5000);expect(recovered.attempts[2].usedMs).toBe(200);
 expect(await readFile(join(config.dataDir,'sessions/synthetic',`${oldHash}.json`),'utf8')).toBe(oldBytes);
 await service.close();const reopened=new HumanGoalService(config);try{expect(reopened.read('synthetic')).toEqual(recovered);}finally{await reopened.close();}
});
it('changing finite config to no-deadline keeps old attempts and refuses same-input recovery under a new binding',async()=>{
 const analyzer:Analyzer={revision:'config-test',async analyze(){throw new Error('synthetic failure');}};
 const {service,config}=await fixture(analyzer);service.feedback('synthetic',goal(0));await service.idle();const old=service.read('synthetic').attempts[0];await service.close();
 const unlimited=new HumanGoalService({...config,analyzer:{...config.analyzer,timeoutMs:null}},analyzer);
 try{let s=unlimited.read('synthetic');expect(s.attempts[0]).toEqual(old);
  expect(()=>unlimited.retry('synthetic',{expectedGeneration:s.generation,idempotencyKey:'same-old',attemptId:old.id,recoveryBasis:'new time config'})).toThrow('绑定已改变');
  unlimited.analyze('synthetic',{expectedGeneration:s.generation,idempotencyKey:'new-binding'});await unlimited.idle();s=unlimited.read('synthetic');
  expect(s.attempts[0]).toEqual(old);expect(s.attempts[1].totalBudgetMs).toBeNull();expect(s.attempts[1].input.inputHash).not.toBe(old.input.inputHash);
 }finally{await unlimited.close();}
});
it('adapter no-deadline omits timeout timer but keeps cancellation and elapsed receipt; finite timeout remains',async()=>{
 const {service,calls}=await fixture();service.feedback('synthetic',goal(0));await service.idle();await service.close();
 const spawn=vi.spyOn(childProcess,'spawn');syncBuiltinESMExports();
 try{
  for(const limit of [null,25]){
   const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
   child.kill=vi.fn(()=>{queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;});spawn.mockReturnValue(child);
   const timer=vi.spyOn(globalThis,'setTimeout'),controller=new AbortController(),dir=join(root,`adapter-${limit}`);
   const adapter=new CodexAnalyzer({command:'synthetic-mocked-spawn',timeoutMs:limit,maxAttempts:1});
   const pending=adapter.analyze(calls[0],dir,controller.signal,limit);const rejected=expect(pending).rejects.toThrow('Codex 分析失败');
   if(limit===null){expect(timer).not.toHaveBeenCalled();controller.abort();}
   await rejected;expect(child.kill).toHaveBeenCalledWith('SIGTERM');
   const receipt=JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));expect(receipt.timeoutMs).toBe(limit);expect(receipt.reason).toBe(limit===null?'cancelled':'timeout');expect(receipt.usedMs).toBeGreaterThanOrEqual(0);
   expect(receipt.argv).not.toContain('-m');timer.mockRestore();
  }
 }finally{vi.restoreAllMocks();syncBuiltinESMExports();}
});
it('workbench shows no-deadline and conservative elapsed accounting in job and attempt details',async()=>{
 const {JSDOM}=createRequire(import.meta.url)('jsdom');const html=await readFile('src/human-goal-workbench/index.html','utf8'),script=await readFile('src/human-goal-workbench/client.js','utf8');
 const dom=new JSDOM(html,{url:'http://127.0.0.1:9999',runScripts:'outside-only'}),w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.matchMedia=()=>({matches:false});w.fetch=async()=>({ok:true,json:async()=>({projects:[]})});
 try{w.eval(script+`state={generation:1,attempts:[{id:'test',state:'interrupted',attemptNumber:1,inputHash:'synthetic-hash',usedMs:12345,totalBudgetMs:null,elapsedAccounting:'conservative-upper-bound',plan:{reason:'synthetic'}}]};renderJob();showAttempt(state.attempts[0]);window.showFinite=()=>{state.attempts[0].totalBudgetMs=5000;state.attempts[0].elapsedAccounting='measured';showAttempt(state.attempts[0]);};`);
  expect(w.document.getElementById('job').textContent).toContain('无时间上限');expect(w.document.getElementById('dialog-body').textContent).toContain('12345 ms（中断后保守计入，非实测模型用量） / 无时间上限');
  w.showFinite();
  expect(w.document.getElementById('dialog-body').textContent).toContain('12345 ms / 5000 ms');
 }finally{await new Promise(r=>setTimeout(r,0));dom.window.close();}
});

it('missing-clause fallback retains legacy IDs and only suffixes actual collisions',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();const input=calls[0],a=model(input);a.alignments=[];a.gaps=[];
  const id=`proposed-${hash('c1').slice(0,12)}`,result=validateAnalysis(a,input);
  expect(result.modules.at(-1)?.id).toBe(id);expect(result.alignments[0].id).toBe(`alignment-${id}`);expect(result.gaps[0].id).toBe(`gap-${id}`);
  const collision=structuredClone(a);collision.modules.push({...a.modules[0],id});const fixed=validateAnalysis(collision,input);
  expect(fixed.modules.at(-1)?.id).toBe(`${id}-1`);expect(fixed.alignments[0].targetIds).toEqual([`${id}-1`]);expect(fixed.gaps[0].targetIds).toEqual([`${id}-1`]);
 }finally{await service.close();}
});
it('raw-only goal edits retain detailed clauses and archive module expectations while covering the complete new intent',async()=>{
 const {service,calls}=await fixture();try{
 service.feedback('synthetic',goal(0));await service.idle();let s=service.read('synthetic');
 service.feedback('synthetic',{expectedGeneration:s.generation,idempotencyKey:'raw-module',originalText:'Keep the reader responsibility',kind:'desired-change',targetIds:['module-a'],author:'test',provenance:'test',analyze:false,expectation:{targetId:'module-a',responsibility:'Read source',inputs:[],outputs:[],examples:[],clauseIds:['c1'],disposition:'required',replaces:[]}});
 s=service.read('synthetic');const oldGoal=structuredClone(s.goals[0]),expectations=structuredClone(s.expectations);
 const raw='Show what each development round changes, whether it advances the product, and module/task gaps.';
 service.feedback('synthetic',{...goal(s.generation,raw,'c1','raw-edit'),clauses:oldGoal.clauses});await service.idle();s=service.read('synthetic');
 const latest=s.goals.at(-1)!,automatic=latest.clauses.find(c=>c.id!=='c1')!;
 expect(latest.clauses).toHaveLength(2);expect(automatic.text).toBe(raw);expect(automatic.constraints.join(' ')).toContain('未作语义拆解');expect(latest.provenance).toContain('自动完整原文核对项');
 expect(latest.clauses.find(c=>c.id==='c1')).toEqual(oldGoal.clauses[0]);expect(s.expectations).toEqual([]);expect(s.expectationHistory?.at(-1)?.expectations).toEqual(expectations);expect(s.expectationHistory?.at(-1)?.goalHash).toBe(oldGoal.hash);expect(s.goals[0]).toEqual(oldGoal);
 expect(calls.at(-1)?.goal).toEqual(latest);expect(calls.at(-1)?.inputHash).not.toBe(calls[0].inputHash);expect(makePrompt(calls.at(-1)!)).toContain('完整原文核对项');
 const omitted=model(calls.at(-1)!);omitted.alignments=omitted.alignments.filter(a=>!a.clauseIds.includes(automatic.id));omitted.gaps=[];
 const validated=validateAnalysis(omitted,calls.at(-1)!);expect(validated.alignments.some(a=>a.clauseIds.includes(automatic.id)&&a.status==='unknown')).toBe(true);expect(validated.gaps.some(g=>g.clauseIds.includes(automatic.id))).toBe(true);
 const version2=structuredClone(latest);
 service.feedback('synthetic',{...goal(s.generation,'A different complete intention','c1','raw-edit-again'),clauses:latest.clauses});await service.idle();s=service.read('synthetic');
 expect(s.goals.at(-1)?.clauses).toHaveLength(2);expect(s.goals.at(-1)?.clauses.find(c=>c.id===automatic.id)?.text).toBe('A different complete intention');expect(s.goals[1]).toEqual(version2);expect(s.expectations).toEqual([]);expect(s.expectationHistory?.at(-1)?.expectations).toEqual(expectations);expect(s.expectationHistory?.at(-1)?.goalHash).toBe(oldGoal.hash);
 }finally{await service.close();}
});

it('raw-only API input creates a goal without clauses and explicit detailed edits keep their meaning',async()=>{
 const {service}=await fixture();try{
 const req={expectedGeneration:0,idempotencyKey:'raw-first',originalText:'An entire original intention',kind:'desired-change',targetIds:[],author:'test',provenance:'test',analyze:false};
 service.feedback('synthetic',req);let s=service.read('synthetic');expect(s.goals).toHaveLength(1);expect(s.goals[0].clauses[0].text).toBe(req.originalText);
 const old=structuredClone(s.goals[0]);service.feedback('synthetic',{...req,expectedGeneration:s.generation,idempotencyKey:'raw-no-clauses',originalText:'Updated entire original intention'});s=service.read('synthetic');expect(s.goals.at(-1)?.clauses[0].id).toBe(old.clauses[0].id);expect(s.goals[0]).toEqual(old);
 const explicit=[{id:'explicit-clause',text:'User edited criterion',importance:'optional',constraints:[],examples:['A concrete example']}];
 service.feedback('synthetic',{...req,expectedGeneration:s.generation,idempotencyKey:'explicit-detail',originalText:'Updated entire original intention',clauses:explicit});s=service.read('synthetic');expect(s.goals.at(-1)?.clauses).toEqual(explicit);
 service.feedback('synthetic',{...req,expectedGeneration:s.generation,idempotencyKey:'correction-only',kind:'interpretation-correction',originalText:'Correct your interpretation'});expect(service.read('synthetic').goals).toEqual(s.goals);
 }finally{await service.close();}
});



it('resaving a legacy omitted raw goal repairs coverage without rewriting its saved history',async()=>{
 const {service}=await fixture();try{
 const req={...goal(0,'Legacy new intention','c1','legacy-goal'),clauses:[{id:'c1',text:'Older criterion',importance:'core'}],analyze:false};
 service.feedback('synthetic',req);let s=service.read('synthetic');const legacy=structuredClone(s.goals[0]);
 service.feedback('synthetic',{...req,expectedGeneration:s.generation,idempotencyKey:'legacy-resave',clauses:s.goals[0].clauses});s=service.read('synthetic');
 expect(s.goals.at(-1)?.clauses).toHaveLength(2);expect(s.goals.at(-1)?.clauses.some(c=>c.text===req.originalText)).toBe(true);expect(s.goals[0]).toEqual(legacy);
 }finally{await service.close();}
});


it('explicit clause edits preserve retained raw coverage and reject edits falsely labeled as automatic',async()=>{
 const {service}=await fixture();try{
 service.feedback('synthetic',{...goal(0),analyze:false});let s=service.read('synthetic');
 service.feedback('synthetic',{...goal(s.generation,'New raw intent','c1','raw-add'),clauses:s.goals[0].clauses,analyze:false});s=service.read('synthetic');const previous=structuredClone(s.goals.at(-1)!);
 const edited=previous.clauses.map(c=>c.id==='c1'?{...c,text:'Explicit detailed revision',importance:'optional'}:c);
 service.feedback('synthetic',{...goal(s.generation,'Raw and detailed edit together','c1','combined-edit'),clauses:edited,analyze:false});s=service.read('synthetic');
 expect(s.goals.at(-1)?.clauses[0]).toEqual(edited[0]);expect(s.goals.at(-1)?.clauses[1]).toEqual({...previous.clauses[1],text:'Raw and detailed edit together'});expect(s.goals[1]).toEqual(previous);
 const tampered=s.goals.at(-1)!.clauses.map((c,i)=>i===1?{...c,text:'Manually altered automatic criterion'}:c);
 expect(()=>service.feedback('synthetic',{...goal(s.generation,'Raw and detailed edit together','c1','invalid-auto-edit'),clauses:tampered,analyze:false})).toThrow('自动完整原文核对项');expect(service.read('synthetic').goals).toEqual(s.goals);
 }finally{await service.close();}
});

it('ordinary key code is supplied whole before sampling and bounded gaps remain explicit',async()=>{
 const p=await project();const code=Array.from({length:800},(_,i)=>`export const value${i} = "${'x'.repeat(40)}";`).join('\n');
 await writeFile(join(p.sourceRoot,'ordinary.ts'),code);
 const complete=discoverSource(p),f=complete.files.find(f=>f.path==='ordinary.ts')!;
 expect(f.truncated).toBe(false);expect(f.ranges).toEqual([{start:1,end:800}]);expect(f.sha256).toBe(digest(code));
 const bounded=discoverSource(p,{maxBytes:3000,perFileBytes:2000});expect(bounded.partial).toBe(true);expect(bounded.suppliedBytes).toBeLessThanOrEqual(3000);
 expect(bounded.readGaps?.some(g=>g.path==='ordinary.ts'&&g.start>0&&g.end>=g.start)).toBe(true);
});

function orderWorkflow(input:AnalysisInput):NonNullable<Analysis['workflow']>{
 const ref=model(input).purposeRefs[0];
 const step=(id:string,title:string,targetIds=['module-a'])=>({id,title,purpose:'配送订单',actor:'仓库人员',responsibility:title,inputs:['订单'],outputs:['处理结果'],actual:'源码定义处理；未运行',state:'source-supported' as const,targetIds,clauseIds:['c1'],refs:[ref],uncertainty:'运行结果未知'});
 const link=(id:string,from:string,to:string,kind:'branch'|'feedback')=>({id,from,to,kind,condition:id==='retry'?'校验失败':'库存满足',meaning:'传递订单状态',state:'source-supported' as const,refs:[ref]});
 return {status:'established',summary:'订单履约',coverage:'registered-scope',unknowns:[],journeys:[{id:'fulfil-order',title:'订单履约',purpose:'完成交付',clauseIds:['c1'],observed:{steps:[step('receive','接收订单'),step('ship','发货'),step('hold','暂存')],links:[link('ship-branch','receive','ship','branch'),link('hold-branch','receive','hold','branch'),link('retry','hold','receive','feedback')]},desired:{steps:[{...step('notify','通知客户',[]),state:'proposed',refs:[],actual:'仅为期望'}],links:[]}}]};
}
it('workflow admits source-grounded non-project journeys, branches and feedback without inventing array sequence',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();const input=calls[0],a=model(input);a.workflow=orderWorkflow(input);
 const result=validateAnalysis(a,input);expect(result.workflow).toEqual(a.workflow);expect(result.workflow!.journeys[0].observed.links).toHaveLength(3);
 const legacy=model(input);expect(validateAnalysis(legacy,input).workflow).toBeUndefined();expect(legacy.edges[0].kind).toBeUndefined();expect(()=>providerAnalysisSchema.parse(legacy)).toThrow();
 expect(outputSchema.required).toContain('workflow');expect(outputSchema.properties.edges.items.required).toEqual(expect.arrayContaining(['kind','certainty']));expect(makePrompt(input)).toContain('不将数组相邻项');
 const unknown=structuredClone(a);unknown.workflow!.journeys[0].observed.steps.push({...unknown.workflow!.journeys[0].observed.steps[0],id:'unmapped',state:'unknown',targetIds:[],refs:[]});
 expect(validateAnalysis(unknown,input).workflow!.unknowns.join(' ')).toContain('未定位实现');
 }finally{await service.close();}
});
it('workflow rejects dangling, duplicate, unsupported and observed/proposed crossovers and partial completeness',async()=>{
 const {service,calls}=await fixture();try{service.feedback('synthetic',goal(0));await service.idle();const input=calls[0],a=model(input);a.workflow=orderWorkflow(input);
 const reject=(edit:(v:Analysis)=>void)=>{const v=structuredClone(a);edit(v);expect(()=>validateAnalysis(v,input)).toThrow();};
 reject(v=>{v.workflow!.journeys[0].observed.links[0].to='absent';});
 reject(v=>{v.workflow!.journeys[0].observed.steps[1].id='receive';});
 reject(v=>{v.workflow!.journeys[0].observed.steps[0].targetIds=['module-a','module-a'];});
 reject(v=>{const step=v.workflow!.journeys[0].observed.steps[0];step.refs.push(step.refs[0]);});
 reject(v=>{v.workflow!.journeys[0].observed.steps[0].state='proposed';});
 reject(v=>{v.workflow!.journeys[0].observed.links[0].to='notify';});
 reject(v=>{v.workflow!.journeys[0].observed.steps[0].refs=[];});
 reject(v=>{v.modules[0].kind='proposed';});
 reject(v=>{v.workflow!.journeys[0].observed.links[0].refs=[];});
 reject(v=>{v.workflow!.journeys[0].desired.steps[0].state='source-supported';});
 reject(v=>{v.workflow!.journeys[0].observed.steps[0].clauseIds=['bogus'];});
 reject(v=>{v.workflow!.journeys[0].observed.steps[0].refs[0].end=999;});
 reject(v=>{v.edges[0].kind='dependency';v.edges[0].certainty='source-supported';v.edges[0].refs=[];});
 expect(()=>validateAnalysis(a,{...input,source:{...input.source,partial:true}})).toThrow('未读范围');
 a.workflow!.coverage='partial';expect(validateAnalysis(a,{...input,source:{...input.source,partial:true}}).workflow!.unknowns.join(' ')).toContain('整体成立性');
 }finally{await service.close();}
});

import { projectInputTransport, reconstructInputTransport, CODEX_INPUT_MAX_CHARS } from '../../src/core/human-goal-workflow/analyzer.js';
it('lossless readable inventory transport preserves every evidence binding and exact record variant without mutation',async()=>{
 const {service,calls}=await fixture();service.feedback('synthetic',goal(0));await service.idle();await service.close();
 const input=structuredClone(calls[0]);
 const record={path:'目录/😀-source.ts',sha256:'a'.repeat(64),bytes:null};
 const variants=[record,{...record,bytes:0},{...record,sha256:'b'.repeat(64)},{...record,path:'other.ts'},{...record,extra:'future evidence'}];
 input.rounds={events:[{roundId:'r1',attemptId:'a1',sourceSnapshotId:'s1',uncertainty:'unknown'}],snapshots:[
  ...Array.from({length:12},(_,i)=>({id:`s${i}`,sourceHash:`source-${i}`,inventory:[...variants,record],observedAt:`time-${i}`,partial:true,coverage:['registered only']})),
  {id:'future-shape',inventoryRefs:['literal-evidence'],unknown:'preserve'},
  {id:'collision',inventory:[record],inventoryRefs:['literal-evidence']},
  {id:'empty',inventory:[]},
 ],conflicts:[{reason:'retained'}]};
 const before=JSON.stringify(input),transport=projectInputTransport(input),restored=reconstructInputTransport(JSON.parse(JSON.stringify(transport)));
 expect(transport.schemaVersion).toBe('project-os.analysis-input-transport.v1');expect(transport.decoding).toContain('preserving ref order and duplicates');
 expect(transport.inventoryEntries).toHaveLength(5);expect(new Set(transport.inventoryEntries.map(e=>e.ref)).size).toBe(5);
 expect(transport.inventoryEntries.map(e=>e.record)).toEqual(variants);
 expect((transport.input.rounds as any).snapshots[0].inventoryRefs[0]).toBe((transport.input.rounds as any).snapshots[0].inventoryRefs[5]);
 expect(JSON.stringify(restored)).toBe(before);expect(JSON.stringify(input)).toBe(before);
 expect(projectInputTransport(input)).toEqual(transport);expect(restored.inputHash).toBe(input.inputHash);expect(restored.materialHash).toBe(input.materialHash);
 const invalid=structuredClone(transport);(invalid.input.rounds as any).snapshots[0].inventoryRefs[0]='missing';expect(()=>reconstructInputTransport(invalid)).toThrow('缺少 inventory ref');
 const duplicate=structuredClone(transport);duplicate.inventoryEntries.push(duplicate.inventoryEntries[0]);expect(()=>reconstructInputTransport(duplicate)).toThrow('重复 inventory ref');
 const tampered=structuredClone(transport);(tampered.inventoryEntries[0].record as any).bytes=123;expect(()=>reconstructInputTransport(tampered)).toThrow('hash 不匹配');
 // Source admission still resolves against the original supplied ranges, never inventory refs.
 const bad=model(input);bad.purposeRefs[0].path=transport.inventoryEntries[0].ref;expect(()=>validateAnalysis(bad,input)).toThrow('分析引用未提供的源行');
});
it('portable oversized history fixture fits the cap with full source and events after inventory deduplication',async()=>{
 const {service,calls}=await fixture();service.feedback('synthetic',goal(0));await service.idle();await service.close();
 const input=structuredClone(calls[0]);input.source.files[0].excerpt='完整源码😀'.repeat(100000);
 const inventory=Array.from({length:40},(_,i)=>({path:`long/registered/source/${'p'.repeat(80)}/${i}.ts`,sha256:digest(String(i)),bytes:i}));
 input.rounds={snapshots:Array.from({length:51},(_,i)=>({id:`snapshot-${i}`,sourceHash:digest(String(i)),inventory,observedAt:String(i)})),events:Array.from({length:659},(_,i)=>({roundId:`round-${i}`,attemptId:`attempt-${i}`,description:'original event',sequence:i}))};
 const before=JSON.stringify(input);expect(before.length).toBeGreaterThan(CODEX_INPUT_MAX_CHARS);
 const prompt=makePrompt(input);expect(prompt.length).toBeLessThan(CODEX_INPUT_MAX_CHARS);expect(prompt).toContain(input.source.files[0].excerpt);
 const restored=reconstructInputTransport(projectInputTransport(input));expect(JSON.stringify(restored)).toBe(before);expect(JSON.stringify(input)).toBe(before);
});
it('large repeating event evidence uses readable v2 rows and exact string tables without losing literal or unknown fields',async()=>{
 const {service,calls}=await fixture();service.feedback('synthetic',goal(0));await service.idle();await service.close();
 const input=structuredClone(calls[0]);input.source.files[0].excerpt='SOURCE-😀'.repeat(80000);
 input.rounds={future:{note:'unknown round evidence',ref:0},events:Array.from({length:1000},(_,i)=>({
   key:`key-${i}-${digest(`key-${i}`)}`,projectId:'synthetic',roundId:`round-${i%17}`,
   attemptId:`attempt-${i%17}`,producerId:`producer-${i%17}`,registrationId:`registration-${i%17}`,
   kind:i%2?'agent-action':'source-observed',description:'full original event evidence',
   rawHash:digest(`raw-${i}`),observedAt:`2026-09-23T00:00:${String(i).padStart(4,'0')}Z`,sequence:i,
   literal:{ref:0,eventRows:['a literal object, not a transport reference']},
   ...(i===0?{futureField:{nested:['preserved',null,0]}}:{})
 }))};
 const before=JSON.stringify(input),transport=projectInputTransport(input);
 expect(before.length).toBeGreaterThan(CODEX_INPUT_MAX_CHARS);
 expect(transport.schemaVersion).toBe('project-os.analysis-input-transport.v2');
 expect(transport.eventEncoding?.fieldSets.length).toBe(2);
 expect(transport.eventEncoding?.stringTables.some(table=>table.field==='roundId')).toBe(true);
 expect((transport.input.rounds as any).events).toBeUndefined();
 expect((transport.input.rounds as any).eventRows).toHaveLength(1000);
 expect(makePrompt(input).length).toBeLessThan(CODEX_INPUT_MAX_CHARS);
 expect(JSON.stringify(reconstructInputTransport(JSON.parse(JSON.stringify(transport))))).toBe(before);
 expect(JSON.stringify(input)).toBe(before);
 const missing=structuredClone(transport),rounds=missing.input.rounds as any;
 const shape=rounds.eventRows[0][0],field=missing.eventEncoding!.fieldSets[shape].indexOf('roundId');
 rounds.eventRows[0][1][field]=99999;expect(()=>reconstructInputTransport(missing)).toThrow('缺少 event string ref');
 const duplicate=structuredClone(transport),table=duplicate.eventEncoding!.stringTables.find(table=>table.field==='roundId')!;
 table.values[1]=table.values[0];expect(()=>reconstructInputTransport(duplicate)).toThrow('重复或无效 event string table');
 const tampered=structuredClone(transport);((tampered.input.rounds as any).eventRows[0][1] as any[])[missing.eventEncoding!.fieldSets[shape].indexOf('literal')].ref=1;
 expect(()=>reconstructInputTransport(tampered)).toThrow('hash 不匹配');
 const collision=structuredClone(input);(collision.rounds as any).eventRows=['original literal field'];
 expect(projectInputTransport(collision).schemaVersion).toBe('project-os.analysis-input-transport.v1');
 expect(()=>makePrompt(collision)).toThrow('INPUT_TOO_LARGE');
 const incompressible=structuredClone(input);incompressible.source.files[0].excerpt='x'.repeat(CODEX_INPUT_MAX_CHARS+1);
 expect(projectInputTransport(incompressible).schemaVersion).toBe('project-os.analysis-input-transport.v2');
 expect(()=>makePrompt(incompressible)).toThrow('INPUT_TOO_LARGE');
});
it('UTF-16 request guard accepts the exact cap and records noncompressible overflow before any spawn',async()=>{
 const {service,calls}=await fixture();service.feedback('synthetic',goal(0));await service.idle();await service.close();
 const input=structuredClone(calls[0]);input.plan.reason='';
 const room=CODEX_INPUT_MAX_CHARS-makePrompt(input).length;input.plan.reason='😀'.repeat(Math.floor(room/2))+'x'.repeat(room%2);
 expect(makePrompt(input).length).toBe(CODEX_INPUT_MAX_CHARS);
 input.plan.reason+='😀';expect(()=>makePrompt(input)).toThrow('INPUT_TOO_LARGE');
 const spawn=vi.spyOn(childProcess,'spawn');syncBuiltinESMExports();
 try{
  const dir=join(root,'too-large'),adapter=new CodexAnalyzer({command:'must-not-spawn',timeoutMs:null,maxAttempts:1});
  await expect(adapter.analyze(input,dir,new AbortController().signal,null)).rejects.toMatchObject({code:'INPUT_TOO_LARGE',status:413});
  expect(spawn).not.toHaveBeenCalled();
  const request=await readFile(join(dir,'request.txt'),'utf8'),invocation=JSON.parse(await readFile(join(dir,'invocation.json'),'utf8')),receipt=JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));
  expect(request.length).toBe(CODEX_INPUT_MAX_CHARS+2);expect(invocation.requestHash).toBe(digest(request));
  expect(receipt).toMatchObject({reason:'INPUT_TOO_LARGE',spawned:false,code:null,transport:{requestChars:CODEX_INPUT_MAX_CHARS+2,maxChars:CODEX_INPUT_MAX_CHARS,charUnit:'UTF-16',reconstructionVerified:true,originalInputSha256:digest(JSON.stringify(input)),inventoryEntryCount:0}});
  expect(receipt.transport).toEqual(invocation.transport);expect(receipt.limitation).toContain('未截断证据');
 }finally{vi.restoreAllMocks();syncBuiltinESMExports();}
});
