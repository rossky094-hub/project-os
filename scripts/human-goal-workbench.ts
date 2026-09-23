import { readFileSync } from 'node:fs';
import { HumanGoalService } from '../src/core/human-goal-workflow/service.js';
import { startServer } from '../src/human-goal-workbench/server.js';
const args=process.argv.slice(2),command=args.shift()??'help';
const flag=(key:string)=>{const index=args.indexOf(`--${key}`);return index<0?undefined:args[index+1];};
async function main(){
 if(command==='help'){console.log('node --import tsx scripts/human-goal-workbench.ts serve|inspect|intake|analyze|feedback|retry|observations|actions --config FILE --project ID [--request JSON_FILE]\nUse HTTP while server holds exclusive write lease. inspect is a separate process only after server stops.');return;}
 const config=flag('config');if(!config)throw new Error('--config FILE required');const service=new HumanGoalService(JSON.parse(readFileSync(config,'utf8')),undefined,{dispatchRoundAnalysis:command==='serve'});
 if(command==='serve'){try{const app=await startServer(service);console.log(JSON.stringify({url:app.url,dataDir:service.store.root,artifactVersion:'0.6.0'}));let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();};process.on('SIGINT',stop);process.on('SIGTERM',stop);}catch(e){await service.close();throw e;}return;}
 try{const id=flag('project');if(!id)throw new Error('--project ID required');const request=flag('request'),payload=request?JSON.parse(readFileSync(request,'utf8')):null;
 let result:unknown;switch(command){case'inspect':result=service.read(id);break;case'intake':case'analyze':result=payload?.clauses?service.feedback(id,payload):service.analyze(id,payload??{expectedGeneration:service.read(id).generation,idempotencyKey:`cli-${Date.now()}`});await service.idle();break;case'feedback':result=service.feedback(id,payload);await service.idle();break;case'retry':result=service.retry(id,payload);await service.idle();break;case'observations':result=service.observe(id,payload);break;case'actions':result=service.action(id,payload);break;default:throw new Error('Unknown command');}console.log(JSON.stringify({result,state:service.read(id)},null,2));}finally{await service.close();}
}
main().catch(e=>{console.error(JSON.stringify({error:String(e),code:e.code??null}));process.exitCode=1;});
