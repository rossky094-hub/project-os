import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverSource} from '../../src/core/human-goal-workflow/source.js';
import {projectSchema} from '../../src/core/human-goal-workflow/types.js';
it('explicit source allowance supplies a slightly over-default scope whole while lower overrides remain bounded',()=>{
 const root=mkdtempSync(join(tmpdir(),'source-policy-'));
 try {
  for(let i=0;i<8;i++)writeFileSync(join(root,`part-${i}.ts`),Array.from({length:800},(_,n)=>`export const value${n} = '${'x'.repeat(92)}';`).join('\n'));
  const base={id:'self',label:'self',sourceRoot:root,scope:['.'],revision:'test',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case'};
  const normal=discoverSource(projectSchema.parse(base));expect(normal.partial).toBe(true);expect(normal.suppliedBytes).toBeLessThanOrEqual(350000);
  const project=projectSchema.parse({...base,sourceReadPolicy:{maxBytes:1048576}}),full=discoverSource(project);
  expect(full.partial).toBe(false);expect(full.readGaps).toEqual([]);expect(full.files.every(f=>!f.truncated)).toBe(true);expect(full.suppliedBytes).toBeGreaterThan(750000);expect(full.suppliedBytes).toBeLessThanOrEqual(1048576);
  const bounded=discoverSource(project,{maxBytes:16000});expect(bounded.partial).toBe(true);expect(bounded.suppliedBytes).toBeLessThanOrEqual(16000);
  for(const value of [0,1048577,1.5,'1048576'])expect(()=>projectSchema.parse({...base,sourceReadPolicy:{maxBytes:value}})).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {HumanGoalService} from '../../src/core/human-goal-workflow/service.js';
it('allows a reading-budget change across reopen while retaining project identity restrictions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'source-policy-reopen-'));const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'main.ts'),'export const answer=1;');
 const config={dataDir:join(root,'data'),projects:[{id:'self',label:'self',sourceRoot:source,scope:['main.ts'],revision:'test',sourceKind:'working-tree',subjectId:'self',caseRole:'self-case'}]};
 let service=new HumanGoalService(config,undefined,{dispatchRoundAnalysis:false});
 try{
  service.feedback('self',{expectedGeneration:0,idempotencyKey:'goal',kind:'desired-change',originalText:'Read this project',author:'owner',provenance:'test',analyze:false});const before=service.read('self');await service.close();
  service=new HumanGoalService({...config,projects:[{...config.projects[0],sourceReadPolicy:{maxBytes:1048576}}]},undefined,{dispatchRoundAnalysis:false});
  expect(service.read('self')).toEqual(before);await service.close();
  service=new HumanGoalService({...config,projects:[{...config.projects[0],scope:['.']}]},undefined,{dispatchRoundAnalysis:false});
  expect(()=>service.read('self')).toThrow('项目登记身份已改变');
 }finally{await service.close();rmSync(root,{recursive:true,force:true});}
});
