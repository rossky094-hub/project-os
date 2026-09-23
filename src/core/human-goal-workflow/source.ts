import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, extname, join } from 'node:path';
import { digest, hash, schemaVersion, WorkflowError, type Project, type SourceSnapshot } from './types.js';
export function contained(root: string, path: string): boolean { const r = relative(root,path); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r)); }
export function safePath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0') || path.includes('\\')) throw new WorkflowError('SOURCE_PATH_REFUSED','来源路径越界');
  const base = realpathSync(root), dest = resolve(base,path);
  if (!contained(base,dest)) throw new WorkflowError('SOURCE_PATH_REFUSED','来源路径越界');
  let cursor = base;
  for (const part of relative(base,dest).split('/').filter(Boolean)) { cursor = join(cursor,part); if (lstatSync(cursor).isSymbolicLink()) throw new WorkflowError('SOURCE_SYMLINK_REFUSED','不读取符号链接'); }
  if (!contained(base,realpathSync(dest))) throw new WorkflowError('SOURCE_PATH_REFUSED','来源路径越界');
  return dest;
}
export function readSource(project: Project, path: string): string {
  if(project.exclude?.some(x=>contained(resolve(project.sourceRoot,x),resolve(project.sourceRoot,path))))throw new WorkflowError('SOURCE_SCOPE_REFUSED','文件在排除范围');
  const full = safePath(project.sourceRoot,path);
  if (!project.scope.some(scope => contained(resolve(realpathSync(project.sourceRoot),scope),full))) throw new WorkflowError('SOURCE_SCOPE_REFUSED','文件不在已登记范围');
  if (!lstatSync(full).isFile() || lstatSync(full).size > 5_000_000) throw new WorkflowError('SOURCE_LIMIT','文件不是可读小型源文件');
  return readFileSync(full,'utf8');
}
const ignored = new Set(['.git','node_modules','dist','build','.venv','venv','__pycache__','.starter-os','.codex','.agents']);
const extensions = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.json','.md','.yaml','.yml','.toml','.txt','.css','.html']);
function priority(p: string): number { return /^(README\.md|package\.json|pyproject\.toml)$/i.test(p) ? -1 : /(^|\/)(tests?|docs?|fixtures?|archive)(\/|$)/i.test(p) ? 3 : /\.(py|ts|tsx|js|jsx)$/.test(p) ? 0 : /(^|\/)(package\.json|pyproject\.toml|README.md)$/.test(p) ? 1 : 2; }
export function discoverSource(project: Project, limits: { maxFiles?: number; maxBytes?: number; perFileBytes?: number } = {}): SourceSnapshot {
  const root = realpathSync(project.sourceRoot), files: string[] = [], omitted: SourceSnapshot['omitted'] = []; let entries = 0;
  const maxFiles = Math.min(200,limits.maxFiles ?? 200), maxBytes = Math.max(0,Math.min(750000,limits.maxBytes ?? 750000)), perFile = Math.max(0,Math.min(200000,limits.perFileBytes ?? 200000));
  function walk(path: string) {
    if (++entries > 10000) throw new WorkflowError('SOURCE_INVENTORY_LIMIT','超过 10000 个目录项，请缩小登记范围');
    if(project.exclude?.some(x=>contained(resolve(root,x),resolve(root,path)))){omitted.push({path,reason:'configured exclusion'});return;}
    const full = resolve(root,path); const stat = lstatSync(full);
    if (stat.isSymbolicLink()) { omitted.push({path,reason:'symlink refused'}); return; }
    if (stat.isDirectory()) { for (const name of readdirSync(full).sort()) { const child = path === '.' ? name : `${path}/${name}`; if (ignored.has(name)) omitted.push({path:child,reason:'excluded generated/private directory'}); else walk(child); } }
    else if (stat.isFile()) { if (extensions.has(extname(path)) && !/package-lock\.json$/.test(path)) files.push(path); else omitted.push({path,reason:'unsupported or lockfile'}); }
  }
  for (const scope of project.scope) { safePath(root,scope); walk(scope); }
  const inventory: SourceSnapshot['inventory'] = [], selected: SourceSnapshot['files'] = []; let suppliedBytes = 0;
  for (const path of [...new Set(files)].sort((a,b) => priority(a)-priority(b)||a.localeCompare(b))) {
    if (lstatSync(resolve(root,path)).size > 5_000_000) { omitted.push({path,reason:'file > 5 MB'}); continue; }
    const raw = readSource(project,path);inventory.push({path,sha256:digest(Buffer.from(raw)),bytes:Buffer.byteLength(raw)});
  }
  // Whole-scope mode supplies ordinary files completely when they fit. If the
  // scope exceeds the context ceiling, retain a bounded overview of every file
  // rather than starving late entries. That fallback cannot establish completeness.
  const renderedSize=(raw:string)=>Buffer.byteLength(`[SOURCE WINDOW 1-${raw.split('\n').length}]\n`+raw.split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n'));
  const capacities=inventory.slice(0,maxFiles).map(f=>Math.min(perFile,renderedSize(readSource(project,f.path))));
  const overflow=capacities.reduce((n,b)=>n+b,0)>maxBytes;
  const overviewBytes=Math.min(maxBytes,350000);
  const overviewCaps=capacities.map(b=>Math.min(b,16000));
  const overviewTotal=overviewCaps.reduce((n,b)=>n+b,0);
  const smallReserve=overviewCaps.filter(b=>b<=1600).reduce((n,b)=>n+b,0);
  const allocation=(index:number)=>smallReserve<overviewBytes?(overviewCaps[index]<=1600?overviewCaps[index]:Math.floor((overviewBytes-smallReserve)*overviewCaps[index]/Math.max(1,overviewTotal-smallReserve))):Math.floor(overviewBytes*overviewCaps[index]/Math.max(1,overviewTotal));
  for (const [fileIndex,{path,sha256,bytes}] of inventory.entries()) {
    if(fileIndex>=maxFiles){omitted.push({path,reason:'context limit'});continue;}
    const raw=readSource(project,path);if(digest(raw)!==sha256)throw new WorkflowError('REVISION_MISMATCH',`读取期间源发生变化: ${path}`);
    const lines=raw.split('\n'),chosen=new Set<number>();
    const budget=overflow?Math.min(overviewCaps[fileIndex],allocation(fileIndex),overviewBytes-suppliedBytes):Math.min(perFile,maxBytes-suppliedBytes);
    const rangesOf=(indices:number[])=>{const ranges:{start:number;end:number}[]=[];for(const index of indices){const last=ranges.at(-1);if(last&&last.end===index)last.end=index+1;else ranges.push({start:index+1,end:index+1});}return ranges;};
    const render=(ranges:{start:number;end:number}[])=>{const parts:string[]=[];let previous=0;for(const r of ranges){if(r.start>previous+1)parts.push(`[OMITTED lines ${previous+1}-${r.start-1}; NOT SUPPLIED]`);parts.push(`[SOURCE WINDOW ${r.start}-${r.end}]`);for(let i=r.start-1;i<r.end;i++)parts.push(`${i+1}: ${lines[i]}`);previous=r.end;}if(previous<lines.length)parts.push(`[OMITTED lines ${previous+1}-${lines.length}; NOT SUPPLIED]`);return parts.join('\n');};
    const addWindow=(start:number,end:number)=>{const next=new Set(chosen);for(let i=Math.max(0,start);i<Math.min(lines.length,end);i++)next.add(i);const indices=[...next].sort((a,b)=>a-b);if(Buffer.byteLength(render(rangesOf(indices)))>budget)return false;for(const i of next)chosen.add(i);return true;};
    if(!addWindow(0,lines.length)){
      // Whole contiguous windows, never isolated signatures followed by invisible
      // holes. Visit early/late/middle symbols before expanding existing windows.
      const signatures=lines.flatMap((line,index)=> /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function|class|def)\s+\w+|^\s*(?:public |private |async )*\w+\([^;]*\)\s*[:{]/.test(line)?[index]:[]);
      addWindow(0,Math.min(12,signatures.find(i=>i>0)??12));
      const anchors:number[]=[];if(signatures.length){anchors.push(signatures[0]);if(signatures.length>1)anchors.push(signatures.at(-1)!);const queue=[[1,signatures.length-2]];while(queue.length&&anchors.length<64){const [lo,hi]=queue.shift()!;if(lo>hi)continue;const mid=Math.floor((lo+hi)/2);anchors.push(signatures[mid]);queue.push([lo,mid-1],[mid+1,hi]);}}
      if(!anchors.length)anchors.push(0,Math.floor(lines.length/2),Math.max(0,lines.length-8));
      for(const index of anchors)addWindow(index,index+8);
      // Expand accepted windows in contiguous chunks while space remains.
      for(let pass=0;pass<32;pass++){let grew=false;for(const r of rangesOf([...chosen].sort((a,b)=>a-b))){if(r.end<lines.length&&addWindow(r.end,r.end+8))grew=true;}if(!grew)break;}
    }
    const indices=[...chosen].sort((a,b)=>a-b),ranges=rangesOf(indices);
    if(!indices.length){omitted.push({path,reason:'no contiguous window fits excerpt budget'});continue;}
    const excerpt=render(ranges);suppliedBytes+=Buffer.byteLength(excerpt);
    selected.push({path,sha256,bytes,lines:lines.length,excerpt,suppliedLines:indices.length,ranges,truncated:indices.length<lines.length,symbols:indices.flatMap(index=>{const m=lines[index].match(/(?:export\s+)?(?:async\s+)?(?:function|class|def)\s+(\w+)/);return m?[`${m[1]}:${index+1}`]:[];})});
  }
  if (!selected.length) throw new WorkflowError('SOURCE_EMPTY','登记范围没有可供分析的来源');
  if (project.snapshotManifest) {
    const manifest = JSON.parse(readFileSync(project.snapshotManifest,'utf8'));
    if ((manifest.snapshot_root || manifest.root) && realpathSync(manifest.snapshot_root || manifest.root) !== root) throw new WorkflowError('REVISION_MISMATCH','快照根目录不匹配');
    const expected = manifest.files ?? manifest.selectedFiles;
    if (!expected || typeof expected !== 'object') throw new WorkflowError('IDENTITY_UNRESOLVED','快照清单缺 files');
    for (const [path,sha] of Object.entries(expected)) if (digest(readSource(project,path)) !== sha) throw new WorkflowError('REVISION_MISMATCH',`快照字节不符: ${path}`);
  }
  // A second read catches source movement during the capture. No mixed-time snapshot is admitted.
  for (const f of inventory) if (digest(readSource(project,f.path)) !== f.sha256) throw new WorkflowError('REVISION_MISMATCH',`读取期间源发生变化: ${f.path}`);
  const relationships: SourceSnapshot['relationships'] = [];
  const paths = new Set(inventory.map(f=>f.path));
  for (const file of selected) file.excerpt.split('\n').forEach((numberedLine) => {
    if(!/^\d+: /.test(numberedLine))return;
    const sep=numberedLine.indexOf(': '), index=Number(numberedLine.slice(0,sep))-1, line=numberedLine.slice(sep+2);
    const m = line.match(/(?:from\s+['"]([^'"]+)['"]|(?:import|from)\s+([.\w]+)|require\(['"]([^'"]+)['"]\))/); const name = m?.[1] ?? m?.[2] ?? m?.[3]; if (!name) return;
    const python=extname(file.path)==='.py';
    const dots=python?(name.match(/^\.+/)?.[0].length??0):0;
    const stem=python ? (dots ? relative(root,resolve(root,dirname(file.path),...Array(Math.max(0,dots-1)).fill('..'),name.slice(dots).replace(/\./g,'/'))) : name.replace(/\./g,'/')) : name.startsWith('.') ? relative(root,resolve(root,dirname(file.path),name)) : name;
    const candidates = [stem,`${stem}.ts`,`${stem}.js`,`${stem}.py`,`${stem}/index.ts`,`${stem}/__init__.py`,stem.replace(/\.js$/,'.ts')];
    const target = candidates.find(c => paths.has(c)); if (target) relationships.push({from:file.path,to:target,kind:'static-import (not execution)',line:index+1});
  });
  const sourceHash = hash({root,projectId:project.id,subjectId:project.subjectId,scope:project.scope,revision:project.revision,inventory:[...inventory].sort((a,b)=>a.path.localeCompare(b.path)),omitted});
  const readGaps: NonNullable<SourceSnapshot['readGaps']> = [];
  for(const f of inventory){
    const supplied=selected.find(x=>x.path===f.path), count=supplied?.lines??readSource(project,f.path).split('\n').length;
    let next=1;
    for(const range of supplied?.ranges??[]){if(range.start>next)readGaps.push({path:f.path,start:next,end:range.start-1,reason:'not supplied: context budget'});next=range.end+1;}
    if(next<=count)readGaps.push({path:f.path,start:next,end:count,reason:'not supplied: context budget'});
  }
  return {readGaps,schemaVersion,id:`source-${sourceHash.slice(0,16)}`,hash:sourceHash,projectId:project.id,subjectId:project.subjectId,root,scope:project.scope,declaredRevision:project.revision,sourceKind:project.sourceKind,caseRole:project.caseRole,observedAt:new Date().toISOString(),runtime:existsSync(join(root,'.starter-os'))?'present: .starter-os (not read)':'verified-absent: .starter-os only; other runtimes unexamined',files:selected,inventory,omitted,partial:omitted.length>0||selected.some(f=>f.truncated),totalBytes:inventory.reduce((n,f)=>n+f.bytes,0),suppliedBytes,relationships};
}
