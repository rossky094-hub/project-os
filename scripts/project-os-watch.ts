import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { HumanGoalService } from '../src/core/human-goal-workflow/service.js';
import { projectActivity } from '../src/core/human-goal-workflow/agent-activity.js';
import { configSchema } from '../src/core/human-goal-workflow/types.js';

const args=process.argv.slice(2),flag=(name:string)=>{const index=args.indexOf(`--${name}`);return index<0?undefined:args[index+1];};
function loopback(value:string){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Only a 127.0.0.1 service URL is allowed');return u.origin;}
async function main(){
 if(args.includes('--help')){console.log('project-os-watch.ts --config FILE --project ID [--connection ID] [--url http://127.0.0.1:PORT] [--once]\nRead-only selected-session follower. With --url, the running service owns polling; this command displays its state. No Codex command is launched.');return;}
 const path=flag('config'),id=flag('project');if(!path||!id)throw new Error('--config and --project are required');
 const config=configSchema.parse(JSON.parse(readFileSync(path,'utf8')));if(!config.projects.some(p=>p.id===id))throw new Error('Project is not registered');
 const url=flag('url')?loopback(flag('url')!):null,connectionId=flag('connection');let service:HumanGoalService|undefined,stopped=false,last='';
 const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  if(!url)service=new HumanGoalService(config,undefined,{dispatchRoundAnalysis:false});
  do{
   let projection:ReturnType<typeof projectActivity>;
   if(url){const response=await fetch(`${url}/api/projects/${encodeURIComponent(id)}/activity`);if(!response.ok)throw new Error(await response.text());projection=await response.json() as ReturnType<typeof projectActivity>;}
   else {if(connectionId)service!.activity.poll(id,connectionId);else service!.activity.pollAll();projection=projectActivity(service!.read(id),service!.closedLoop(id).sourceHash);}
   const selected=connectionId?projection.connections.filter(c=>c.id===connectionId):projection.connections;
   if(connectionId&&!selected.length)throw new Error('Selected connection is not registered');
   const summary={revision:projection.revision,connections:selected.map(c=>({id:c.id,status:c.status,issue:c.issue,lastReceivedAt:c.lastReceivedAt,cursor:c.cursor,relevance:c.relevance})),turns:projection.turns.filter(t=>!connectionId||t.connectionId===connectionId).map(t=>({turnId:t.turnId,roundId:t.roundId,status:t.status,purpose:t.purpose,agents:t.agents.map(a=>({label:a.label,status:a.status})),passedConditions:t.passedConditions}))};
   const rendered=JSON.stringify(summary);if(rendered!==last){console.log(JSON.stringify(summary,null,2));last=rendered;}
   if(args.includes('--once'))break;
   await new Promise(r=>setTimeout(r,1000));
  }while(!stopped);
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await service?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:String(e),code:e.code??null}));process.exitCode=1;});
