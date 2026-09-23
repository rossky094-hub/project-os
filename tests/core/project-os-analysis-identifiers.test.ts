import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { CODEX_INPUT_MAX_CHARS, makePrompt, projectInputTransport, reconstructInputTransport } from '../../src/core/human-goal-workflow/analyzer.js';
import { digest, type AnalysisInput } from '../../src/core/human-goal-workflow/types.js';

const hex=(name:string)=>createHash('sha256').update(name).digest('hex');
function inputWithHistory(excerptChars:number,eventCount=5000):AnalysisInput {
 const shared=hex('inventory');
 return {
  schemaVersion:'fixture',project:{id:'fixture'},source:{files:[{path:'main.ts',excerpt:'S'.repeat(excerptChars),sha256:shared}]},
  goal:{originalText:`Preserve literal ~h and ${shared} in the human goal`},expectations:[],
  feedback:[{originalText:'~c is literal',rawHash:hex('feedback')}],
  observations:[{key:`obs-event-${hex('observation').slice(0,40)}`,unknown:{literal:'~o-not-an-identifier',number:42}}],
  previous:{unknownFields:[hex('previous'),`codex-${hex('previous-key').slice(0,40)}`]},
  closedLoop:{unknown:{literal:'~h-not-base64',repeat:[1,1,2]}},
  rounds:{snapshots:[{inventory:[{path:'main.ts',sha256:shared,bytes:7,unknown:hex('record').slice(0,40)}]},{inventory:[{path:'main.ts',sha256:shared,bytes:7,unknown:hex('record').slice(0,40)}]}],
   events:Array.from({length:eventCount},(_,i)=>({key:i%3===0?`codex-${hex(`event-${i}`).slice(0,40)}`:i%3===1?`obs-event-${hex(`event-${i}`).slice(0,40)}`:hex(`event-${i}`).slice(0,40),
    rawHash:hex(`raw-${i}`),observedAt:new Date(1_700_000_000_000+i*1000).toISOString(),unknown:{value:i,other:hex(`unknown-${i}`).slice(0,40)}}))},
  previousSourceHash:null,generation:1,inputHash:hex('input'),analyzerRevision:'fixture',configHash:hex('config'),
  plan:{reason:'fixture',targetIds:[],sourcePaths:[],reuse:[],limitations:[]},
 } as unknown as AnalysisInput;
}

it('uses v4 only to fit complete mixed identifiers and restores exact input bytes',()=>{
 const input=inputWithHistory(100_000),original=JSON.stringify(input),transport=projectInputTransport(input);
 expect(transport.schemaVersion).toBe('project-os.analysis-input-transport.v4');
 expect(transport.identifierEncoding).toMatchObject({version:'canonical-hex-base64.v1'});
 expect(transport.identifierEncoding!.encodedCount).toBeGreaterThan(0);
 const encoded=JSON.stringify({rounds:transport.input.rounds,inventoryEntries:transport.inventoryEntries,eventEncoding:transport.eventEncoding,metadataEncoding:transport.metadataEncoding});
 for(const tag of ['~h','~H','~c','~o'])expect(encoded).toContain(tag);
 expect(JSON.stringify(transport.input.source.files)).toBe(JSON.stringify(input.source.files));
 expect(JSON.stringify(transport.input.goal)).toBe(JSON.stringify(input.goal));
 expect(JSON.stringify(transport.input.feedback)).toContain('~~c');
 expect(JSON.stringify(transport.input.closedLoop)).toContain('~~h');
 expect(transport.originalInputSha256).toBe(digest(original));
 const wire=JSON.stringify(transport);
 expect(JSON.stringify(reconstructInputTransport(JSON.parse(wire)))).toBe(original);
 expect(JSON.stringify(transport)).toBe(wire);
 expect(makePrompt(input).length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS);
});

it('rejects invalid v4 metadata, tags, lengths, base64 and changed references',()=>{
 const input=inputWithHistory(100_000),transport=projectInputTransport(input);
 expect(transport.schemaVersion).toBe('project-os.analysis-input-transport.v4');
 const bad=(change:(t:any)=>void)=>{const candidate=structuredClone(transport);change(candidate);try{reconstructInputTransport(candidate);throw Error('invalid transport accepted');}catch(error){expect(error).toMatchObject({code:'TRANSPORT_INVALID'});}};
 bad(t=>{delete t.identifierEncoding;});
 bad(t=>{t.identifierEncoding.version='unknown';});
 bad(t=>{t.identifierEncoding.encodedCount++;});
 bad(t=>{t.inventoryEntries[0].record.sha256='~H@@@';});
 bad(t=>{t.inventoryEntries[0].record.sha256='~HAAAA';});
 bad(t=>{t.inventoryEntries[0].record.sha256='~H'+Buffer.alloc(32).toString('base64').replace(/=/g,'');});
 bad(t=>{t.input.feedback[0].rawHash='~xAAAA';});
 bad(t=>{t.input.rounds.eventRows[0][1][0]='~cAAAA';});
 bad(t=>{t.originalInputSha256=hex('forged');});
 bad(t=>{t.schemaVersion='project-os.analysis-input-transport.v5';});
});

it('keeps v1-v3 readable and still rejects an oversized uncompressible excerpt',()=>{
 const small=inputWithHistory(20,0),v1=projectInputTransport(small);
 expect(v1.schemaVersion).toBe('project-os.analysis-input-transport.v1');
 expect(JSON.stringify(reconstructInputTransport(v1))).toBe(JSON.stringify(small));
 const simple=inputWithHistory(850_000,3000);
 (simple.rounds as any).events=Array.from({length:3000},(_,i)=>({key:`event-${i}`,kind:'begin',observedAt:'2023-11-14T22:13:20.000Z',payload:'same'}));
 const variants=[inputWithHistory(0),simple];
 const versions=variants.map(input=>{const transport=projectInputTransport(input);expect(JSON.stringify(reconstructInputTransport(transport))).toBe(JSON.stringify(input));return transport.schemaVersion;});
 expect(versions).toContain('project-os.analysis-input-transport.v2');
 expect(versions).toContain('project-os.analysis-input-transport.v3');
 const tooLarge=inputWithHistory(CODEX_INPUT_MAX_CHARS+1,0);
 expect(()=>makePrompt(tooLarge)).toThrow('INPUT_TOO_LARGE');
});
