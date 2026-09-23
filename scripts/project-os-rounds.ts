import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HumanGoalService } from '../src/core/human-goal-workflow/service.js';
import { configSchema } from '../src/core/human-goal-workflow/types.js';
import { projectRounds, snapshotRequestSchema, registrationRequestSchema } from '../src/core/human-goal-workflow/rounds.js';
import { projectActivity } from '../src/core/human-goal-workflow/agent-activity.js';
const args=process.argv.slice(2),command=args.shift()??'help';
const flag=(name:string)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
async function main(){
 if(command==='help'){console.log('project-os-rounds.ts status|snapshot|enroll|replay|follow|checkpoint|evidence|activity|connect|activity-replay --config FILE --project ID [--request FILE] [--url http://127.0.0.1:PORT] [--output FILE]\nconnect takes an explicit selected-stream request; the running service then follows it automatically. Historical replay requires a pre-existing baseline. No Codex process is launched.');return;}
 const configPath=flag('config'),id=flag('project');if(!configPath||!id)throw new Error('--config and --project required');
 const config=configSchema.parse(JSON.parse(readFileSync(configPath,'utf8'))),request=flag('request'),payload=request?JSON.parse(readFileSync(request,'utf8')):{},routes:Record<string,string>={status:'rounds',snapshot:'round-snapshot',enroll:'round-enroll',replay:'round-replay',follow:'round-replay',checkpoint:'round-checkpoint',evidence:'round-evidence',activity:'activity',connect:'activity-connect','activity-replay':'activity-replay'};
 if(!routes[command])throw new Error('Unknown command');
 const endpointFile=join(config.dataDir,'server-endpoint.json');let url=flag('url');
 if(!url&&existsSync(endpointFile)){const endpoint=JSON.parse(readFileSync(endpointFile,'utf8'));url=endpoint.url;}
 let service:HumanGoalService|undefined;
 try{
  if(url){const parsed=new URL(url);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('Only loopback server URL allowed');url=parsed.origin;}
  else service=new HumanGoalService(config,undefined,{dispatchRoundAnalysis:false});
  const run=async()=>{
   if(url){const readonly=command==='status'||command==='activity';const res=await fetch(`${url}/api/projects/${encodeURIComponent(id)}/${routes[command]}`,{method:readonly?'GET':'POST',headers:readonly?{}:{Origin:url,'Content-Type':'application/json'},body:readonly?undefined:JSON.stringify(payload)});const result=await res.json();if(!res.ok)throw new Error(JSON.stringify(result));return result;}
   const s=service!;
   switch(command){case'status':return {...projectRounds(s.read(id),config.roundPolicy),eventReadPolicy:config.eventReadPolicy,analysisPolicy:config.roundAnalysis,analysisJobs:s.read(id).roundAnalysis?.jobs??[]};case'activity':return projectActivity(s.read(id),s.closedLoop(id).sourceHash);case'connect':return s.activity.connect(id,payload);case'activity-replay':return s.activity.replay(id,(payload as {connectionId:string}).connectionId);case'snapshot':{const request=snapshotRequestSchema.parse(payload);return request.import?s.rounds.importSnapshot(id,request.import):s.rounds.capture(id);}case'enroll':return s.rounds.enroll(id,payload);case'replay':case'follow':return s.follower.follow(id,registrationRequestSchema.parse(payload).registrationId);case'checkpoint':return s.rounds.checkpoint(id,registrationRequestSchema.parse(payload).registrationId);case'evidence':return s.importRoundEvidence(id,payload);}
  };
  let stopped=false;const stop=()=>{stopped=true;};if(command==='follow'){process.on('SIGINT',stop);process.on('SIGTERM',stop);}
  do {const result=await run(),rendered=JSON.stringify(result,null,2);if(flag('output'))writeFileSync(flag('output')!,rendered,{mode:0o600});console.log(rendered);if(command!=='follow'||result&&typeof result==='object'&&'status' in result&&['terminal','sync-error','unsupported'].includes(String(result.status)))break;await new Promise(resolve=>setTimeout(resolve,1000));}while(!stopped);
 }finally{await service?.close();}
}
main().catch(e=>{console.error(JSON.stringify({error:String(e),code:e.code??null}));process.exitCode=1;});
