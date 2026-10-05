import { afterEach, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAnalyzer, makePrompt, outputSchema } from '../../src/core/human-goal-workflow/analyzer.js';
import { HumanGoalService } from '../../src/core/human-goal-workflow/service.js';
import type { AnalysisInput } from '../../src/core/human-goal-workflow/types.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();syncBuiltinESMExports();for(const done of cleanups.splice(0).reverse())await done();});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'analyzer-isolation-')),source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'main.ts'),'export const result = 1;\n');
 let input!:AnalysisInput;
 const service=new HumanGoalService({projects:[{id:'fixture',label:'Synthetic isolation fixture',sourceRoot:source,scope:['.'],revision:'fixture',sourceKind:'snapshot',subjectId:'fixture',caseRole:'self-case'}],dataDir:join(root,'data'),analyzer:{timeoutMs:null}},{revision:'synthetic-input-capture',async analyze(value){input=value;throw new Error('Synthetic input capture only; no model call');}},{dispatchRoundAnalysis:false});
 cleanups.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 service.feedback('fixture',{expectedGeneration:0,idempotencyKey:'fixture',kind:'desired-change',originalText:'Synthetic fixture goal',targetIds:[],author:'fixture',provenance:'fixture',clauses:[{id:'goal',text:'Read a result',importance:'core'}]});await service.idle();
 return {root,source,input};
}
// Only process isolation is tested. This schema-shaped synthetic output is not
// a model interpretation, a source-semantic judgment or product acceptance.
function synthetic(schema:any):any{
 if(schema.enum)return schema.enum[0];
 if(schema.type==='object')return Object.fromEntries(Object.entries(schema.properties).map(([key,value])=>[key,synthetic(value)]));
 if(schema.type==='array')return Array.from({length:schema.minItems||0},()=>synthetic(schema.items));
 if(schema.type==='string')return schema.pattern?.includes('{64}')?'a'.repeat(64):'synthetic';
 return schema.minimum??0;
}
function processFixture(args:string[],metadata:unknown,hang=false){
 const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
 child.kill=vi.fn(()=>{queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;});
 child.stdin.on('finish',()=>{if(hang)return;if(args.includes('mcp'))child.stdout.write(JSON.stringify(args[0]==='mcp'&&!args.includes('-c')?metadata:Array.isArray(metadata)?metadata.map(entry=>({...entry,enabled:false})):metadata));else {writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(synthetic(outputSchema)));child.stdout.write('{"type":"turn.completed"}\n');}child.emit('close',0,null);});
 return child;
}
it('disables inherited MCP servers only for analysis, preserves model/hooks and does not store credential-bearing metadata',async()=>{
 const {root,input}=await fixture(),dir=join(root,'attempt'),metadata=[{name:'cua_repl',enabled:true,transport:{type:'stdio',command:'synthetic-plugin-command',env:{API_KEY:'PRIVATE_ENV_SENTINEL'}}},{name:'basic_memory',enabled:true},{name:'already_disabled',enabled:false}];
 const spawn=vi.spyOn(childProcess,'spawn').mockImplementation((_cmd,args)=>processFixture(args as string[],metadata));syncBuiltinESMExports();
 await new CodexAnalyzer({command:'synthetic-codex',timeoutMs:null,maxAttempts:1}).analyze(input,dir,new AbortController().signal,null);
 expect(spawn.mock.calls.map(call=>call[1]?.[0])).toEqual(['mcp','-c','exec']);
 const argv=spawn.mock.calls[2][1] as string[];
 expect(argv).toContain('mcp_servers.cua_repl.command="synthetic-plugin-command"');
 for(const name of ['cua_repl','basic_memory'])expect(argv).toContain(`mcp_servers.${name}.enabled=false`);
 expect(argv).not.toContain('mcp_servers.already_disabled.enabled=false');
 expect(argv).toContain('read-only');expect(argv).not.toContain('-m');expect(argv).not.toContain('--ignore-user-config');expect(argv).not.toContain('--ignore-rules');expect(argv).not.toContain('--dangerously-bypass-hook-trust');
 const invocation=JSON.parse(readFileSync(join(dir,'invocation.json'),'utf8'));expect(invocation.toolIsolation).toEqual({status:'configured-mcp-disabled',configuredServers:['already_disabled','basic_memory','cua_repl'],disabledServers:['basic_memory','cua_repl']});
 for(const file of ['invocation.json','mcp-preflight.json','receipt.json'])expect(readFileSync(join(dir,file),'utf8')).not.toContain('PRIVATE_ENV_SENTINEL');
 expect(readFileSync(join(dir,'request.txt'),'utf8')).toBe(makePrompt(input));
});
it.each([{label:'non-list',metadata:{}},{label:'unaddressable name',metadata:[{name:'unresolved.name',enabled:true}]}])('refuses $label MCP metadata before sending source to the model',async ({metadata})=>{
 const {root,input}=await fixture(),dir=join(root,'attempt');const spawn=vi.spyOn(childProcess,'spawn').mockImplementation((_cmd,args)=>processFixture(args as string[],metadata));syncBuiltinESMExports();
 await expect(new CodexAnalyzer({command:'synthetic-codex',timeoutMs:null,maxAttempts:1}).analyze(input,dir,new AbortController().signal,null)).rejects.toThrow('未启动模型');
 expect(spawn).toHaveBeenCalledTimes(1);expect(JSON.parse(readFileSync(join(dir,'receipt.json'),'utf8'))).toMatchObject({reason:'mcp_metadata_unresolved',analysisSpawned:false});
});
it('keeps cancellation available after MCP isolation without adding a model deadline',async()=>{
 const {root,input}=await fixture(),dir=join(root,'attempt'),controller=new AbortController();let model:any,ready!:()=>void;
 const started=new Promise<void>(resolve=>{ready=resolve;});
 vi.spyOn(childProcess,'spawn').mockImplementation((_cmd,args)=>{const a=args as string[],child=processFixture(a,[],a[0]==='exec');if(a[0]==='exec'){model=child;ready();}return child;});syncBuiltinESMExports();
 const pending=new CodexAnalyzer({command:'synthetic-codex',timeoutMs:null,maxAttempts:1}).analyze(input,dir,controller.signal,null),rejected=expect(pending).rejects.toThrow('cancelled');
 await started;controller.abort();await rejected;expect(model.kill).toHaveBeenCalledWith('SIGTERM');expect(JSON.parse(readFileSync(join(dir,'receipt.json'),'utf8'))).toMatchObject({timeoutMs:null,reason:'cancelled',toolIsolation:{status:'configured-mcp-disabled'}});
});
