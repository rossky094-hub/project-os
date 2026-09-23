const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const svgEl=(tag,attrs={})=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const statusNames={'unknown':'未知 / 缺证','implemented-unverified':'实现线索 · 待验证','downstream-blocked':'下游受阻','verified-aligned':'限定范围已验证','verified-mismatch':'限定范围不符','proposed':'拟需能力','open':'待处理','scope-changed':'目标范围变化','retracted':'分析已撤回','stale':'旧判断待核查','resolved':'修复验证合格','queued':'排队中','running':'正在分析','completed':'分析完成','partial':'部分范围分析','failed':'分析失败','interrupted':'已中断'};
const kinds={'interpretation-correction':'程序理解有误','desired-change':'我希望的是','evidence-contribution':'补充事实 / 认可当前理解'};
const importanceNames={'hard-constraint':'硬约束','core':'核心目标','supporting':'支持目标','optional':'可选目标'};
let projectId='',state=null,view=null,selection=null,projects=[],pan={x:0,y:0,zoom:1},positions=new Map(),polling=false,lastStamp='',editing=false;
let selectedRound=null,cameraBinding=null,workspace='map',historicalRound=null;
let modelView='mainline',journeyId=null,mainlineReturn='agents',mainlineReturnRound=null;
const cameras=new Map();
const nodeSize={width:210,height:100};let layoutColumns=1;
function graphBinding(){return view?JSON.stringify(['folded-desktop-v1',layoutColumns,projectId,view.attemptId,view.source.hash,view.goal?.hash]):null;}
function validPan(value){return value&&[value.x,value.y,value.zoom].every(Number.isFinite)&&value.zoom>0;}
function ensureGraphCamera(){const binding=graphBinding();if(!binding||binding===cameraBinding)return;if(cameraBinding)cameras.set(cameraBinding,{...pan});const saved=cameras.get(binding)||(pref.projectId===projectId&&pref.cameraBinding===binding?pref.pan:null);if(validPan(saved)){pan={...saved,zoom:Math.max(.85,saved.zoom)};cameraBinding=binding;applyPan();}else fit();}
let pref={};try{pref=JSON.parse(localStorage.getItem('hg-reading')||'{}');}catch{}
if(pref.theme==='dark')document.body.classList.add('dark');document.body.dataset.panel='map';
function savePref(){try{localStorage.setItem('hg-reading',JSON.stringify({theme:document.body.classList.contains('dark')?'dark':'light',projectId,selection:historicalRound?null:selection,pan,cameraBinding}));}catch{}}
function button(label,fn,cls){const b=el('button',label,cls);b.type='button';b.onclick=fn;return b;}
function badge(text,cls=''){return el('span',statusNames[text]||text,`badge ${cls}`);}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok){const error=new Error(`${data.code}: ${data.message}`);error.data=data;throw error;}return data;}
const endpoint=op=>`/api/projects/${encodeURIComponent(projectId)}/${op}`;
const key=()=>crypto.randomUUID();
async function submit(op,payload){try{notice('');const result=await api(endpoint(op),{expectedGeneration:state.generation,idempotencyKey:key(),...payload});if(result.analysisError)notice(`反馈已保存，但分析尚未启动：${result.analysisError}`);await refresh(true);return result;}catch(e){notice(e.message);throw e;}}
function currentGoal(){return state?.goals.at(-1)||null;}
function isRawCriterion(c){return c.id.startsWith('raw-goal-')&&c.constraints?.includes('自动完整原文核对项：逐字保留目标原文；未作语义拆解，未经人类逐条确认。');}
function elapsed(a){const start=Date.parse(a.state==='queued'?a.createdAt:a.startedAt);const ms=['queued','running'].includes(a.state)&&Number.isFinite(start)?Math.max(0,Date.now()-start):a.usedMs||0;const seconds=Math.floor(ms/1000);return `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;}
function renderLifecycle(){
 const goal=currentGoal(),latest=state.attempts.at(-1),active=state.attempts.filter(a=>['queued','running'].includes(a.state));
 const saved=goal?`已保存目标 G${goal.version}`:'尚未提供人类目标';
 const pending=!!historicalRound||!view||view.goal?.hash!==goal?.hash||(state.diagnosisStatus?state.diagnosisStatus==='stale':view.generation!==state.generation);
 const retained=historicalRound?'正在查看明确选定的历史图；当前分析可从项目图页签返回。':view?`保留上次图（目标 ${view.goal?`G${view.goal.version}`:'未提供'}）；新结果发布前不会替换。`:'尚无分析图，等待分析结果。';
 const parts=[saved];
 if(active.length){for(const a of active)parts.push(`${a.state==='running'?'正在分析':'正在排队：分析'}目标 ${a.goalVersion==null?'未提供':`G${a.goalVersion}`} · ${a.state==='queued'?'已等待':'本次已用'} ${elapsed(a)}${a.totalBudgetMs===null?' · 无时间上限，可取消':''}`);parts.push(retained);}
 else if(latest&&['failed','interrupted'].includes(latest.state))parts.push(`${statusNames[latest.state]}（目标 ${latest.goalVersion==null?'未提供':`G${latest.goalVersion}`}）；目标和执行记录已保留，可查看失败详情。`,retained);
 else if(latest&&['completed','partial'].includes(latest.state)){
  if(latest.promoted&&view?.attemptId===latest.id&&!pending)parts.push(`目标 ${latest.goalVersion==null?'未提供':`G${latest.goalVersion}`} 分析完成，图已更新${latest.state==='partial'?'（部分来源）':''}；分析结果仍需核对与验证。`);
  else parts.push('已有分析结束，但最新目标或反馈尚无发布结果；旧结果仅供历史核查，未发布为当前反馈的结果。',retained);
 }else parts.push('等待新分析；保存目标不代表分析已完成。',retained);
 const message=parts.join(' ');
 for(const [id,anchor]of [['goal-analysis-status','goal-summary'],['map-analysis-status','graph-wrap'],['workflow-analysis-status','workflow-content']]){
  let box=$(id);if(!box){box=el('div',undefined,'analysis-status');box.id=id;box.setAttribute('role','status');box.setAttribute('aria-live','polite');if(id==='goal-analysis-status')$(anchor).after(box);else $(anchor).before(box);}
  if(box.dataset.message!==message){box.dataset.message=message;if(id!=='goal-analysis-status'){const detail=el('details');detail.append(el('summary',active.length?'正在分析，保留上次图':pending?'当前判断待更新':latest&&['failed','interrupted'].includes(latest.state)?'分析未成功，可查看记录':'图已更新 · 解释仍需验证'),el('p',message));box.replaceChildren(detail);}else box.textContent=message;}
  box.dataset.state=active.length?'pending':pending?'stale':latest?.state||'idle';
 }
}

async function refresh(force=false){if(polling||!projectId)return;polling=true;const requestedProject=projectId;try{const data=await api(endpoint('state'));if(requestedProject!==projectId)return;state=data;if(!data.rounds?.rounds?.some(r=>r.id===selectedRound))selectedRound=data.rounds?.rounds?.at(-1)?.id||null;view=displayedView();const stamp=JSON.stringify([projectId,data.currentView,data.diagnosisStatus,data.closedLoop?.status,data.closedLoop?.receipts?.map(r=>[r.id,r.current]),data.goals.at(-1)?.hash,data.generation,data.attempts.map(a=>[a.id,a.state,a.error]),data.actions.length,data.rounds?.revision,data.activity?.revision,data.mainline?.revision,data.mainline?.sourceHash,data.rounds?.registrations?.map(r=>[r.status,r.cursor,r.issue]),data.roundAnalysis?.jobs?.map(j=>[j.id,j.state,j.error])]);renderJob();renderLifecycle();if(force||stamp!==lastStamp){lastStamp=stamp;render();} }catch(e){if(requestedProject===projectId)notice(e.message);}finally{polling=false;if(requestedProject!==projectId)await refresh(true);}}
function renderJob(){const a=state.attempts.at(-1);$('job').replaceChildren();if(a){$('job').append(badge(a.state),document.createTextNode(` · 目标 ${a.goalVersion==null?'未提供':`G${a.goalVersion}`} · ${elapsed(a)}${a.totalBudgetMs===null?' · 无时间上限':''}`));if(['running','queued'].includes(a.state))$('job').append(button('取消',()=>api(endpoint('cancel'),{attemptId:a.id}).then(()=>refresh(true)).catch(e=>notice(e.message))));else if(['failed','interrupted'].includes(a.state))$('job').append(button('查看失败 / 恢复',()=>showAttempt(a)));}$('analyze').disabled=state.attempts.some(a=>['running','queued'].includes(a.state));$('analyze').textContent=view?'重新检查来源':a&&['running','queued'].includes(a.state)?'正在理解代码…':'开始理解代码';$('save-state').textContent=`持久化 revision ${state.generation} · 已保存到本地服务`;}
function render(){const reading=captureReading();const rounds=state.rounds?.rounds||[];if(!rounds.some(r=>r.id===selectedRound))selectedRound=rounds.at(-1)?.id||null;view=displayedView();const p=projects.find(p=>p.id===projectId);$('identity').textContent=`${p.label} · ${p.sourceKind==='snapshot'?'保留源快照（非实时仓库）':'已登记工作树'}`;$('generation').textContent=`${currentGoal()?`G${currentGoal().version}`:'目标未提供'}${view&&view.goal?.hash!==currentGoal()?.hash?' · 图为上次目标结果':''}`;$('purpose').textContent=view?.analysis.purpose||'从实际来源开始理解';$('coverage').textContent=view?`${view.source.files.length} / ${view.source.inventory.length} 个候选文件 · ${Math.round(view.source.suppliedBytes/1024)} KB 片段 / ${Math.round(view.source.totalBytes/1024)} KB 来源 · ${view.source.partial?'部分覆盖，未读完整文件':'已读取登记范围'} · 尚未执行 subject`:'分析会留下实际源文件、行号、覆盖范围与新的执行记录。';$('goal-summary').textContent=currentGoal()?.originalText||'还没有人类目标。可先理解代码，也可直接填写你的期望。';$('clauses').replaceChildren(...(currentGoal()?.clauses||[]).map(c=>button(`${isRawCriterion(c)?'完整原文核对项（自动保留）':importanceNames[c.importance]} · ${c.text}`,()=>select('clause',c.id))));if(selection&&!view?.analysis.modules.some(m=>m.id===selection.id)&&selection.kind==='module'){const repl=view?.analysis.modules.filter(m=>m.supersedes.includes(selection.id))||[];if(repl.length===1)selection.id=repl[0].id;else if(repl.length>1)notice(`选中模块有多个替代，请在图中选择：${repl.map(m=>m.title).join('、')}`);}renderOverall();renderClosedLoop();renderRounds();renderActivity();renderWorkflow();renderGraph();renderGaps();if(!editing)renderDetail();renderMapContext();restoreReading(reading);}
// Focus is a one-hop neighborhood, not transitive reachability or evidence of causality.
function relevant(){
 const ids=new Set();if(!view||!selection)return ids;const a=view.analysis;
 if(selection.kind==='clause')a.alignments.filter(x=>x.clauseIds.includes(selection.id)).forEach(x=>x.targetIds.forEach(t=>ids.add(t)));
 else if(selection.kind==='gap')view.gaps.find(g=>g.id===selection.id)?.targetIds.forEach(t=>ids.add(t));
 else ids.add(selection.id);
 const seeds=new Set(ids);
 for(const edge of a.edges)if(seeds.has(edge.id)||seeds.has(edge.from)||seeds.has(edge.to)){ids.add(edge.id);ids.add(edge.from);ids.add(edge.to);}
 return ids;
}
function select(kind,id){document.querySelector('.goal-evidence').open=false;if(workspace!=='map')switchWorkspace('map');if(kind==='module'||kind==='edge')setModelView('implementation');selection={kind,id};savePref();editing=false;document.body.classList.add('inspector-open');renderGraph();renderGaps();renderDetail();revealSelection();if(matchMedia('(max-width:700px)').matches)panel('detail');}
// Condense strongly connected components before assigning ranks. Cycles never
// increase their own depth; stable IDs make an unchanged graph deterministic.
function layout(){
 positions=new Map();if(!view)return;
 const nodes=view.analysis.modules.filter(m=>m.kind==='discovered').sort((a,b)=>a.id.localeCompare(b.id));
 const adjacency=new Map(nodes.map(n=>[n.id,[]]));
 for(const e of view.analysis.edges)if(adjacency.has(e.from)&&adjacency.has(e.to))adjacency.get(e.from).push(e.to);
 for(const list of adjacency.values())list.sort();
 const indices=new Map(),low=new Map(),stack=[],active=new Set(),components=[];let index=0;
 function visit(id){
  indices.set(id,index);low.set(id,index++);stack.push(id);active.add(id);
  for(const next of adjacency.get(id)){if(!indices.has(next)){visit(next);low.set(id,Math.min(low.get(id),low.get(next)));}else if(active.has(next))low.set(id,Math.min(low.get(id),indices.get(next)));}
  if(low.get(id)===indices.get(id)){const component=[];let item;do{item=stack.pop();active.delete(item);component.push(item);}while(item!==id);components.push(component.sort());}
 }
 for(const n of nodes)if(!indices.has(n.id))visit(n.id);
 components.sort((a,b)=>a[0].localeCompare(b[0]));const owner=new Map();components.forEach((c,i)=>c.forEach(id=>owner.set(id,i)));
 const outgoing=components.map(()=>new Set()),degree=components.map(()=>0),ranks=components.map(()=>0);
 for(const e of view.analysis.edges){const a=owner.get(e.from),b=owner.get(e.to);if(a!==undefined&&b!==undefined&&a!==b&&!outgoing[a].has(b)){outgoing[a].add(b);degree[b]++;}}
 const queue=degree.flatMap((n,i)=>n===0?[i]:[]);for(let i=0;i<queue.length;i++){const a=queue[i];for(const b of outgoing[a]){ranks[b]=Math.max(ranks[b],ranks[a]+1);if(--degree[b]===0)queue.push(b);}}
 // Fold topological order into the available desktop width. Placement is a
 // reading aid only: the diagram continues to draw only source-supplied edges.
 const bounds=$('graph-wrap').getBoundingClientRect();
 layoutColumns=Math.max(1,Math.min(6,Math.floor((Math.max(250,bounds.width)+10)/236)));
 const ordered=components.map((ids,i)=>({ids,rank:ranks[i]})).sort((a,b)=>a.rank-b.rank||a.ids[0].localeCompare(b.ids[0])).flatMap(c=>c.ids);
 ordered.forEach((id,i)=>positions.set(id,{x:16+(i%layoutColumns)*236,y:16+Math.floor(i/layoutColumns)*(nodeSize.height+16)}));
}
function applyPan(){const group=$('graph').querySelector('#scene');if(group)group.setAttribute('transform',`translate(${pan.x} ${pan.y}) scale(${pan.zoom})`);}
function wrap(value,length,max){const lines=[];let line='',width=0;for(const char of String(value)){const size=/[\u0020-\u007e]/.test(char)?.55:1;if(width+size>length){lines.push(line);line='';width=0;if(lines.length===max){lines[max-1]=lines[max-1].slice(0,-1)+'…';return lines;}}line+=char;width+=size;}if(line)lines.push(line);return lines;}
function renderGraph(){renderProposed();const svg=$('graph');svg.replaceChildren();$('graph-empty').hidden=!!view;$('graph-list').replaceChildren();renderLegend();$('map-count').textContent=view?`${view.analysis.modules.length} 能力 · ${view.analysis.edges.length} 连接`:'';if(!view)return;layout();const defs=svgEl('defs'),marker=svgEl('marker',{id:'arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});marker.append(svgEl('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'var(--muted)'}));defs.append(marker);svg.append(defs);const scene=svgEl('g',{id:'scene'});svg.append(scene);const ids=relevant(),query=$('search').value.toLowerCase();const round=state?.rounds?.rounds?.find(r=>r.id===(historicalRound||selectedRound)),affected=new Set(round?.viewAttemptId===view.attemptId?round.touchedTargets:[]);const chosen=id=>ids.has(id),dim=(id,label)=>query?!label.toLowerCase().includes(query):ids.size&&!chosen(id);
for(const [index,e]of view.analysis.edges.entries()){const from=positions.get(e.from),to=positions.get(e.to);if(!from||!to)continue;const forward=to.x>from.x,self=e.from===e.to,x1=from.x+nodeSize.width,y1=from.y+(self?22:41),x2=to.x+(forward?0:nodeSize.width),y2=to.y+(self?62:41);const mid=forward?(x1+x2)/2:Math.max(x1,x2)+22+(index%3)*7;const d=`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;const g=svgEl('g',{class:`edge ${affected.has(e.id)?'round-affected':''} ${chosen(e.id)?'related':''} ${selection?.id===e.id?'selected':''} ${dim(e.id,e.label)?'dim':''}`,'data-id':e.id,'data-status':view.statuses[e.id]||'unknown',tabindex:0,role:'button','aria-label':`连接 ${relationshipLabel(e)} · ${e.label}，${statusNames[view.statuses[e.id]]||'未知'}`});g.append(svgEl('path',{d,class:'hit'}),svgEl('path',{d,'marker-end':'url(#arrow)'}));const fullLabel=svgEl('title');fullLabel.textContent=relationshipLabel(e)+' · '+e.label;g.append(fullLabel);const t=svgEl('text',{x:mid,y:(y1+y2)/2-9-(index%3)*15,'text-anchor':'middle'});t.textContent=wrap(relationshipLabel(e)+' · '+e.label,14,1)[0];g.append(t);runtimeBadge(g,[e.id],targetClauses(e.id),mid,(y1+y2)/2+17,true);g.onclick=()=>select('edge',e.id);g.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select('edge',e.id);}};scene.append(g);$('graph-list').append(button(`连接 · ${relationshipLabel(e)} · ${e.label} · ${statusNames[view.statuses[e.id]]||'未知'}`,()=>select('edge',e.id),'text-item'));}
for(const n of view.analysis.modules.filter(m=>m.kind==='discovered')){const p=positions.get(n.id),g=svgEl('g',{transform:`translate(${p.x} ${p.y})`,class:`node ${affected.has(n.id)?'round-affected':''} ${n.kind} ${chosen(n.id)?'related':''} ${selection?.id===n.id?'selected':''} ${dim(n.id,n.title+' '+n.responsibility)?'dim':''}`,'data-id':n.id,'data-status':view.statuses[n.id]||'unknown',tabindex:0,role:'button','aria-label':`${n.title}，${statusNames[view.statuses[n.id]]||'未知'}`});const title=svgEl('title');title.textContent=n.title;g.append(title,svgEl('rect',{width:nodeSize.width,height:nodeSize.height,rx:10}));for(const[line,i]of wrap(n.title,12,2).map((line,i)=>[line,i])){const t=svgEl('text',{x:12,y:23+i*19});t.textContent=line;g.append(t);}const stat=svgEl('text',{x:12,y:67,class:'status'});stat.textContent=n.kind==='proposed'?'◇ 拟需能力 · 未定位':statusNames[view.statuses[n.id]]||'未知 / 缺证';g.append(stat);runtimeBadge(g,[n.id],targetClauses(n.id),12,91);g.onclick=()=>select('module',n.id);g.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select('module',n.id);}};scene.append(g);$('graph-list').append(button(`${n.title} · ${statusNames[view.statuses[n.id]]||'未知'}`,()=>select('module',n.id),'text-item'));}ensureGraphCamera();applyPan();}
function revealSelection(){const ids=relevant(),target=[...ids].map(id=>positions.get(id)).find(Boolean);if(!target)return;const bounds=$('graph-wrap').getBoundingClientRect();pan.zoom=Math.max(.9,pan.zoom);pan.x=bounds.width/2-(target.x+nodeSize.width/2)*pan.zoom;pan.y=bounds.height/2-(target.y+nodeSize.height/2)*pan.zoom;applyPan();savePref();}
function fit(){if(!view||!positions.size)return;const bounds=$('graph-wrap').getBoundingClientRect();if(!Number.isFinite(bounds.width)||!Number.isFinite(bounds.height)||bounds.width<=24||bounds.height<=24||getComputedStyle($('graph-wrap')).visibility==='hidden')return;const maxX=Math.max(...[...positions.values()].map(p=>p.x+nodeSize.width+16)),maxY=Math.max(...[...positions.values()].map(p=>p.y+nodeSize.height+16));pan={x:12,y:12,zoom:Math.max(.85,Math.min(1,(bounds.width-24)/maxX,(bounds.height-24)/maxY))};cameraBinding=graphBinding();cameras.set(cameraBinding,{...pan});applyPan();savePref();}
function renderLegend(){
 const host=$('graph-legend');host.replaceChildren();
 for(const status of new Set(view?[...view.analysis.modules,...view.analysis.edges].map(n=>view.statuses[n.id]||'unknown'):[])){const item=el('span',statusNames[status]||status,'legend-item');item.dataset.status=status;host.append(item);}
 host.append(el('span','高亮：所选对象与直接上下游','legend-focus'));
}
function renderGaps(){
 const list=$('gaps');list.replaceChildren();$('next-action').replaceChildren();
 const open=(view?.gaps.filter(g=>g.lifecycle==='open')||[]).sort((a,b)=>a.rank-b.rank||a.id.localeCompare(b.id));
 $('gap-count').textContent=open.length?String(open.length):'';
 if(!view){list.append(el('p','分析后这里会显示有来源的差距和下一步。','muted'));return;}
 if(!currentGoal())list.append(el('p','先填写人类目标，再比较实现差距。','muted'));
 else if(!open.length)list.append(el('p','当前分析未列开放差距；不代表所有行为已验证。','muted'));
 const appendGap=(g,host)=>{const b=button('',()=>select('gap',g.id),`gap ${selection?.id===g.id?'selected':''}`);b.dataset.id=g.id;b.title=g.expected;
 b.append(el('strong',`${g.lifecycle==='open'?`${g.rank}. `:''}${g.expected}`),el('small',`${statusNames[g.lifecycle]||g.lifecycle} · ${g.certainty==='unknown'?'证据未知':'来源支持的假设'}`));host.append(b);};
 for(const g of open.slice(0,5))appendGap(g,list);
 if(open.length>5){const more=el('details');more.id='more-gaps';more.append(el('summary',`其余 ${open.length-5} 项待办`));for(const g of open.slice(5))appendGap(g,more);list.append(more);}
 const closed=view.gaps.filter(g=>g.lifecycle!=='open');if(closed.length){const history=el('details');history.id='closed-gaps';history.append(el('summary',`历史差距 · ${closed.length} 项`));for(const g of closed)appendGap(g,history);list.append(history);}
}
function section(title,text){const box=el('div',undefined,'definition');box.append(el('h3',title),el('p',Array.isArray(text)?text.join('；')||'未说明':text||'未说明'));return box;}
function references(refs,parent){for(const r of refs||[])parent.append(button(`${r.path}:${r.start}–${r.end}`,()=>showSource(r),'source-ref'));}
function renderDetail(){const d=$('detail');d.replaceChildren();$('detail-title').textContent='核对与反馈';if(!view||!selection){d.append(el('p','选择模块、连接或差距，核对解释、目标与来源。','muted'),button('编辑整体目标',()=>wholeForm()),button('反馈记录',showFeedback));return;}const a=view.analysis,kind=selection.kind,id=selection.id;let refs=[];
if(kind==='module'||kind==='edge')runtimeBadge(d,[id],targetClauses(id));
if(kind==='workflow-step'){renderWorkflowStep(id,d);return;}
if(kind==='workflow-link'){renderWorkflowLink(id,d);return;}
if(kind==='module'){const n=a.modules.find(m=>m.id===id);if(!n){d.append(el('p','旧节点已被替换，请从图中选择新的节点。'));return;}$('detail-title').textContent=n.title;const expectation=state.expectations.find(e=>e.targetId===id);d.append(badge(view.statuses[id]),section('当前理解',n.responsibility),section('你希望它负责',expectation?.responsibility||'尚未单独填写模块期望'),section('输入',n.inputs),section('输出',n.outputs));refs=n.refs;d.append(button('核对模块 / 重新分析',()=>moduleForm(n),'primary full'));for(const e of a.edges.filter(e=>e.from===id||e.to===id))d.append(button(`连接：${e.label}`,()=>select('edge',e.id),'text-item'));}
if(kind==='edge'){const e=a.edges.find(e=>e.id===id);if(!e)return;$('detail-title').textContent=e.label;d.append(badge(relationshipLabel(e)),badge(view.statuses[id]),section('应当传递',e.expected),section('来源显示',e.actual),el('p','两端模块测试通过，不会使这条连接自动通过。','muted'));refs=e.refs;d.append(button(a.modules.find(m=>m.id===e.from)?.title||e.from,()=>select('module',e.from)),el('span',' → '),button(a.modules.find(m=>m.id===e.to)?.title||e.to,()=>select('module',e.to)));}
if(kind==='gap'){const g=view.gaps.find(g=>g.id===id);if(!g)return;$('detail-title').textContent='差距与下一步';d.append(badge(g.lifecycle),badge(g.certainty),section('期望结果',g.expected),section('当前依据',g.actual),section('排序理由',g.rankReason),section('竞争原因假设',g.causeHypotheses),section('尚不确定',g.uncertainty),section('下一判别观察',g.nextObservation),section('建议动作',g.action),section('前提',g.prerequisites),section('预期效果',g.expectedOutcome),section('验证方法',g.verificationPlan),button('记录选择这项建议',()=>submit('actions',{gapId:g.id}).then(()=>notice('建议已保存；尚未执行源码修改或检查。')).catch(()=>{})));refs=g.refs;for(const t of g.targetIds){const node=a.modules.find(m=>m.id===t),edge=a.edges.find(e=>e.id===t);d.append(button(node?.title||edge?.label||t,()=>select(node?'module':'edge',t),'text-item'));}if(g.counterEvidence.length){d.append(el('h3','反证'));references(g.counterEvidence,d);}}
if(kind==='clause'){const c=currentGoal()?.clauses.find(c=>c.id===id);$('detail-title').textContent='目标覆盖';d.append(section(importanceNames[c?.importance]||'目标',c?.text));for(const align of a.alignments.filter(x=>x.clauseIds.includes(id))){d.append(section(statusNames[align.status],align.rationale));references(align.refs,d);for(const t of align.targetIds){const n=a.modules.find(n=>n.id===t),e=a.edges.find(e=>e.id===t);d.append(button(n?.title||e?.label||t,()=>select(n?'module':'edge',t),'text-item'));}}d.append(button('修改目标与重要性',wholeForm));}
const linked=a.alignments.filter(x=>x.targetIds.includes(id));
const clauses=[...new Set(linked.flatMap(align=>align.clauseIds))].map(clauseId=>view.goal?.clauses.find(c=>c.id===clauseId)).filter(Boolean);
if(clauses.length){
 const goals=el('details',undefined,'detail-goals'),list=el('ul');
 goals.append(el('summary',`对应目标 · ${clauses.length} 项（展开原文与来源）`));
 for(const clause of clauses){const item=el('li',clause.text);item.dataset.clauseId=clause.id;list.append(item);}goals.append(list);
 const sourceRefs=new Map();for(const ref of linked.flatMap(align=>align.refs||[]))sourceRefs.set(JSON.stringify([ref.path,ref.sha256,ref.start,ref.end]),ref);
 references([...sourceRefs.values()],goals);d.append(goals);
}
const conflicts=a.conflicts.filter(c=>c.targetId===id||c.clauseIds.includes(id));for(const c of conflicts)d.append(el('div',`目标冲突：${c.parentText}\n模块期望：${c.moduleText}\n${c.reason}`,'conflict'));d.append(el('h3','来源依据'));references(refs,d);for(const g of view.gaps.filter(g=>g.targetIds.includes(id)&&g.lifecycle==='open'))d.append(button(`相关差距：${g.expected}`,()=>select('gap',g.id),'text-item'));d.append(button('原始反馈与分类',showFeedback));}
function dialog(title){$('dialog-title').textContent=title;$('dialog-body').replaceChildren();if(!$('dialog').open)$('dialog').showModal();return $('dialog-body');}
function field(parent,label,node){const l=el('label',label,'form-field');parent.append(l,node);l.append(node);return node;}
function selectOptions(items,value){const s=el('select');for(const[k,v]of Object.entries(items)){const o=el('option',v);o.value=k;s.append(o);}s.value=value;return s;}
function wholeForm(originalFeedback){editing=true;const d=dialog('核对整体目标'),form=el('form'),goal=currentGoal(),baseGeneration=state.generation;d.append(form);const kind=field(form,'这段反馈属于',selectOptions(kinds,originalFeedback?.kind||'desired-change'));const original=field(form,'保留你的原话',el('textarea'));original.value=originalFeedback?.originalText||goal?.originalText||'';const clauses=el('div');form.append(el('h3','期望结果与重要性'),el('p','只修改原话也会进入新分析：系统会保留完整原文核对项，不作语义拆解。既有详细条款和模块关联保留，请核对是否仍符合新目标。删除或降低详细目标只改变范围，不算修复。','muted'),clauses);function row(c){const r=el('div',undefined,'clause-row');r.dataset.id=c?.id||`clause-${key()}`;if(c&&isRawCriterion(c))r.append(el('small','完整原文核对项 · 自动逐字保留，未经人类逐条确认；可在原话中更新。'));const input=el('textarea');input.value=c?.text||'';input.readOnly=!!c&&isRawCriterion(c);input.placeholder='例如：重开后仍可看到来源与上次纠正';const imp=selectOptions(importanceNames,c?.importance||'core');r.append(input,imp,button('−',()=>r.remove()));clauses.append(r);}for(const c of goal?.clauses||[null])row(c);form.append(button('＋ 增加目标条款',()=>row(null)));const extra=field(form,'混合反馈可拆成第二条原文（可选）',el('textarea'));extra.placeholder='例如另一句是在纠正程序理解，而不是新增需求';const extraKind=field(form,'第二条分类',selectOptions(kinds,'interpretation-correction'));const submitButton=el('button','保存反馈并重新分析','primary');submitButton.type='submit';form.append(el('p','新分析前保留上次图。解释纠正不会悄悄改写人类目标。','muted'),submitButton);kind.onchange=()=>{clauses.hidden=kind.value!=='desired-change';};kind.onchange();form.onsubmit=async event=>{event.preventDefault();submitButton.disabled=true;try{const rows=[...clauses.children].filter(r=>r.querySelector('textarea').value.trim());if(kind.value==='desired-change'&&goal&&!rows.length)throw new Error('请保留至少一条核对项；删除目标只改变范围。');const payload={expectedGeneration:baseGeneration,originalText:original.value,kind:kind.value,targetIds:[],author:'local-human',provenance:'workbench user input',analyze:!extra.value.trim(),...(originalFeedback?{supersedes:originalFeedback.id}:{}),...(kind.value==='desired-change'&&rows.length?{clauses:rows.map(r=>({id:r.dataset.id,text:r.querySelector('textarea').value,importance:r.querySelector('select').value,constraints:goal?.clauses.find(c=>c.id===r.dataset.id)?.constraints||[],examples:goal?.clauses.find(c=>c.id===r.dataset.id)?.examples||[]}))}:{})};const savedResult=await submit('feedback',payload);if(!savedResult.analysisError)notice(kind.value==='desired-change'?`已保存目标 G${currentGoal()?.version}；分析状态见目标区和图旁。`:'反馈已保存；分析状态见图旁。');if(extra.value.trim())await submit('feedback',{originalText:extra.value,kind:extraKind.value,targetIds:[],author:'local-human',provenance:'workbench split mixed feedback; original parts retained'});editing=false;$('dialog').close();renderDetail();}catch(e){d.append(el('p',e.message,'conflict'));}finally{submitButton.disabled=false;}};}
function moduleForm(n){if(!currentGoal()){wholeForm();return;}editing=true;const d=dialog(n.kind==='proposed'?'提出缺少的能力':'核对模块职责'),form=el('form'),baseGeneration=state.generation;d.append(form);const previous=state.expectations.find(e=>e.targetId===n.id);const kind=field(form,'反馈分类',selectOptions(kinds,'desired-change'));const original=field(form,'你的原始反馈',el('textarea'));original.placeholder='说明理解哪里不对，或你希望发生什么变化';const responsibility=field(form,'期望职责',el('textarea'));responsibility.value=previous?.responsibility||n.responsibility;const inputs=field(form,'输入（每行一项）',el('textarea'));inputs.value=(previous?.inputs||n.inputs).join('\n');const outputs=field(form,'输出（每行一项）',el('textarea'));outputs.value=(previous?.outputs||n.outputs).join('\n');const examples=field(form,'成功例子（每行一项）',el('textarea'));examples.value=(previous?.examples||[]).join('\n');const disposition=field(form,'模块安排',selectOptions({required:'需要这个模块',optional:'可选',unnecessary:'不再需要', 'proposed-missing':'拟需 / 尚未定位'},previous?.disposition||(n.kind==='proposed'?'proposed-missing':'required')));const cs=field(form,'对应整体目标（可多选）',el('select'));cs.multiple=true;for(const c of currentGoal().clauses){const o=el('option',c.text);o.value=c.id;o.selected=previous?.clauseIds.includes(c.id)??true;cs.append(o);}const replacement=field(form,'拆分 / 合并 / 重分配：替代哪些旧模块（可选）',el('select'));replacement.multiple=true;for(const old of view?.analysis.modules||[]){const o=el('option',old.title);o.value=old.id;replacement.append(o);}form.append(el('p','这里只调整理解与期望。若与整体目标冲突，分析会并列展示，整体目标保持原文。','muted'));const b=el('button','保存模块反馈并重新分析','primary');b.type='submit';form.append(b);form.onsubmit=async event=>{event.preventDefault();b.disabled=true;try{await submit('feedback',{expectedGeneration:baseGeneration,originalText:original.value,kind:kind.value,targetIds:n.kind==='proposed'?[]:[n.id],author:'local-human',provenance:'workbench module review',...(kind.value==='desired-change'?{expectation:{targetId:n.id,responsibility:responsibility.value,inputs:inputs.value.split('\n').filter(Boolean),outputs:outputs.value.split('\n').filter(Boolean),examples:examples.value.split('\n').filter(Boolean),clauseIds:[...cs.selectedOptions].map(o=>o.value),disposition:disposition.value,replaces:[...replacement.selectedOptions].map(o=>o.value)}}:{})});editing=false;$('dialog').close();renderDetail();}catch(e){form.append(el('p',e.message,'conflict'));}finally{b.disabled=false;}};}
async function showSource(r){const d=dialog(`${r.path} · 来源行 ${r.start}–${r.end}`);d.append(el('p','读取并核对源文件哈希…','muted'));try{const data=await api(`${endpoint('source')}?path=${encodeURIComponent(r.path)}&sha256=${r.sha256}&start=${r.start}&end=${r.end}`);d.replaceChildren(el('p',`SHA256 ${data.sha256}`,'muted'),el('pre',data.text));}catch(e){d.replaceChildren(el('p',e.message,'conflict'));}}
function showScope(){const d=dialog('实际检查范围');if(!view){d.append(el('p','尚无分析；将扫描登记范围：'),el('pre',projects.find(p=>p.id===projectId).scope.join('\n')));return;}d.append(el('p',view.analysis.coverageNotes),el('p',`源绑定 ${view.source.hash}`,'muted'),el('p',view.source.runtime,'muted'));for(const limitation of view.analysis.limitations)d.append(el('p',limitation,'muted'));for(const f of view.source.files){const box=el('div',undefined,'feedback-card');box.append(el('strong',f.path),el('p',`${f.suppliedLines}/${f.lines} 行 · ${f.truncated?'片段读取':'登记文件全行'} · 实际行段 ${f.ranges.map(r=>`${r.start}–${r.end}`).join(', ')}`,'muted'));for(const r of f.ranges.slice(0,12))box.append(button(`读 ${r.start}–${r.end}`,()=>showSource({...r,path:f.path,sha256:f.sha256}),'linklike'));d.append(box);}d.append(el('h3','未提供的文件 / 范围'));for(const g of view.source.readGaps||[])d.append(el('p',`${g.path}:${g.start}–${g.end} · 未提供，不能推断实现不存在`,'muted'));for(const o of view.source.omitted)d.append(el('p',`${o.path} · ${o.reason}`,'muted'));}
function showFeedback(){const d=dialog('原始反馈、分类与冲突');for(const f of state.feedback){const card=el('div',undefined,'feedback-card');card.append(badge(kinds[f.kind]),el('p',f.originalText),el('p',`${f.author} · ${f.createdAt} · 目标版本 ${f.goalVersion??'无'}${f.supersedes?' · 更正旧反馈分类':''}`,'muted'),button('纠正分类（保留原记录）',()=>wholeForm(f)));d.append(card);}if(!state.feedback.length)d.append(el('p','尚未提交反馈。'));for(const c of state.conflicts)d.append(section(`冲突记录 · ${c.reason}`,JSON.stringify(c.request,null,2)));if(view?.analysis.feedbackResponse)d.append(section('本次来源核查如何回应反馈',view.analysis.feedbackResponse));}
function showAttempt(a){const d=dialog('分析执行与恢复');d.append(badge(a.state),section('错误 / 限制',a.error),section('输入绑定',`${a.inputHash}\n目标 ${a.goalVersion??'未提供'}\n源 ${a.sourceHash}`),section('记录目录',a.rawDir),section('分析计划',a.plan.reason),section('已用 / 总预算',`${a.usedMs} ms${a.elapsedAccounting==='conservative-upper-bound'?'（中断后保守计入，非实测模型用量）':''} / ${a.totalBudgetMs===null?'无时间上限':`${a.totalBudgetMs} ms`}`));if(['failed','interrupted'].includes(a.state)){const reason=field(d,'本次支持的恢复依据',el('textarea'));reason.placeholder='例如执行器暂时不可用已恢复；保持原目标、来源与剩余预算';d.append(button('显式重试（保留失败）',()=>submit('retry',{attemptId:a.id,recoveryBasis:reason.value}).then(()=>{$('dialog').close();editing=false;}).catch(e=>d.append(el('p',e.message,'conflict')))));}}
async function history(){const d=dialog('前后版本与执行历史');try{const all=await api(endpoint('history'));for(const a of all.attempts)d.append(button(`${a.createdAt} · ${statusNames[a.state]} · ${a.promoted?'已发布':'仅记录 / 未发布'}`,()=>showAttempt(a),'text-item'));const options=el('select');for(const[v,i]of all.views.map((v,i)=>[v,i])){const o=el('option',`${v.goal?`G${v.goal.version}`:'目标未提供'} · revision ${v.generation} · ${v.createdAt}`);o.value=String(i);options.append(o);}options.value=String(Math.max(0,all.views.length-1));d.append(el('h3','选择版本，比较其输入与变化'),options);const content=el('div');d.append(content);function show(){const index=Number(options.value),v=all.views[index],before=all.views[index-1];content.replaceChildren();if(!v)return;const pair=el('div',undefined,'compare');for(const [label,item]of [['此前',before],['本次',v]]){const box=el('article');box.append(el('h3',label),section('人类目标',item?.goal?.originalText||'未提供'),section('代码理解',item?.analysis.purpose||'未分析'));pair.append(box);}content.append(pair);for(const[k,val]of Object.entries(v.changes))content.append(section(({goal:'目标变化',interpretation:'解释变化',source:'来源变化',ranking:'排序变化',evidence:'运行证据'})[k]||k,val));content.append(section('反馈吸收',v.analysis.feedbackResponse));for(const g of v.gaps)content.append(section(`${statusNames[g.lifecycle]} · ${g.expected}`,g.closureReason||g.rankReason));}options.onchange=show;show();}catch(e){d.append(el('p',e.message,'conflict'));}}
function panel(name){document.body.dataset.panel=name;if(name==='map')ensureGraphCamera();if(name==='list')$('text-alternative').open=true;document.querySelectorAll('[data-panel]').forEach(b=>{if(b.tagName==='BUTTON')b.classList.toggle('selected',b.dataset.panel===name);});}
$('project').onchange=async()=>{if(cameraBinding)cameras.set(cameraBinding,{...pan});projectId=$('project').value;selectedRound=null;historicalRound=null;selection=null;lastStamp='';cameraBinding=null;pan={x:0,y:0,zoom:1};document.body.classList.remove('inspector-open');await refresh(true);savePref();};$('analyze').onclick=()=>submit('analyze',{}).catch(()=>{});$('edit-goal').onclick=()=>wholeForm();$('sources').onclick=showScope;$('add-module').onclick=()=>moduleForm({id:`proposed-${key()}`,kind:'proposed',responsibility:'',inputs:[],outputs:[]});$('history').onclick=history;$('theme').onclick=()=>{document.body.classList.toggle('dark');savePref();};$('close-dialog').onclick=()=>{$('dialog').close();editing=false;renderDetail();};$('dialog').addEventListener('close',()=>{editing=false;});$('search').oninput=renderGraph;$('fit').onclick=resetMap;$('close-detail').onclick=()=>{document.body.classList.remove('inspector-open');selection=null;savePref();renderGraph();renderGaps();};$('expand-map').onclick=()=>{const expanded=$('map-panel').classList.toggle('expanded');$('expand-map').textContent=expanded?'收起画布':'展开画布';};for(const[id,factor]of [['zoom-in',1.2],['zoom-out',1/1.2]])$(id).onclick=()=>{pan.zoom=Math.max(.85,Math.min(3,pan.zoom*factor));applyPan();savePref();};document.querySelectorAll('button[data-panel]').forEach(b=>b.onclick=()=>panel(b.dataset.panel));document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{if(b.dataset.step==='goal')wholeForm();else if(b.dataset.step==='gaps')panel('gaps');else{panel('map');$('analyze').focus();}});
let drag=null;$('graph').addEventListener('pointerdown',event=>{if(event.target.closest('.node,.edge'))return;drag={x:event.clientX,y:event.clientY,px:pan.x,py:pan.y};$('graph').setPointerCapture(event.pointerId);});$('graph').addEventListener('pointermove',event=>{if(drag){pan.x=drag.px+event.clientX-drag.x;pan.y=drag.py+event.clientY-drag.y;applyPan();}});$('graph').addEventListener('pointerup',()=>{drag=null;savePref();});$('graph').addEventListener('wheel',event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)pan.zoom=Math.max(.85,Math.min(3,pan.zoom*(event.deltaY<0?1.08:1/1.08)));else{pan.x-=event.deltaX;pan.y-=event.deltaY;}applyPan();savePref();},{passive:false});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(view)renderGraph();}).observe($('graph-wrap'));
window.addEventListener('resize',()=>{if(view)renderGraph();});
async function init(){try{const data=await api('/api/projects');projects=data.projects;for(const p of projects){const o=el('option',p.label);o.value=p.id;$('project').append(o);}projectId=projects.some(p=>p.id===pref.projectId)?pref.projectId:projects[0].id;$('project').value=projectId;selection=null;pan=validPan(pref.pan)?{...pref.pan,zoom:Math.max(.85,pref.pan.zoom)}:pan;await refresh(true);setInterval(()=>refresh(),1600);}catch(e){notice(e.message);}}init();

function selectedRoundView(id=historicalRound){const round=state?.rounds?.rounds?.find(r=>r.id===id);return round?.viewAttemptId?[...(state.roundViews||[]),...state.views].find(v=>v.attemptId===round.viewAttemptId&&v.source.hash===round.after?.sourceHash&&v.goal?.hash===round.goalHash):null;}
function displayedView(){return (historicalRound&&selectedRoundView())||(state?.currentView==null?null:state.views[state.currentView]);}
function renderMapContext(){const host=$('map-context');host.replaceChildren();host.hidden=!historicalRound||workspace!=='map';if(historicalRound)host.append(el('span','历史分析 · 仅供核查，不代表当前目标进展'),button('返回当前项目图',()=>switchWorkspace('map')));}
function switchWorkspace(name,historyId=null){
 workspace=name;historicalRound=name==='map'?historyId:null;view=displayedView();
 $('model-views').hidden=name!=='map';$('rounds-panel').hidden=name!=='rounds';$('agents-panel').hidden=name!=='agents';$('map-workspace').hidden=name!=='map';
 for(const key of ['map','rounds','agents']){const tab=$('tab-'+key);tab.setAttribute('aria-selected',String(key===name));tab.tabIndex=key===name?0:-1;}
 document.body.classList.remove('inspector-open');selection=null;render();renderLifecycle();
}
function captureReading(){const focus=document.activeElement;return {focusId:focus?.id,objectId:focus?.dataset?.id,stepId:focus?.dataset?.stepId,flowLink:focus?.dataset?.flowLink,scroll:[...document.querySelectorAll('#mainline-panel,#workflow-scroll,#detail-panel,#detail,#rounds-panel,#round-timeline,#round-detail,#agents-panel,#gaps-panel,#graph-list')].map(n=>[n.id,n.scrollTop,n.scrollLeft]),details:[...document.querySelectorAll('details')].map(n=>[n.id||n.className||n.querySelector('summary')?.textContent,n.open])};}
function restoreReading(reading){for(const [id,top,left]of reading.scroll){if($(id)){$(id).scrollTop=top;$(id).scrollLeft=left;}}for(const n of document.querySelectorAll('details')){const key=n.id||n.className||n.querySelector('summary')?.textContent;const found=reading.details.find(x=>x[0]===key);if(found)n.open=found[1];}if(document.activeElement===document.body){const target=reading.focusId?$(reading.focusId):reading.flowLink?[...document.querySelectorAll('[data-flow-link]')].find(n=>n.dataset.flowLink===reading.flowLink):reading.stepId?[...document.querySelectorAll('[data-step-id]')].find(n=>n.dataset.stepId===reading.stepId):[...document.querySelectorAll('[data-id]')].find(n=>n.dataset.id===reading.objectId);target?.focus({preventScroll:true});}}

function renderOverall(){
 const host=$('overall-diagnosis');if(!host)return;host.replaceChildren();const round=state.rounds?.rounds?.find(r=>r.id===historicalRound),mapped=!round||!round.stale&&round.viewAttemptId===view?.attemptId;const diagnosis=view?.analysis.diagnosis,stale=!!historicalRound||!mapped||state.diagnosisStatus==='stale'||view&&(view.goal?.hash!==currentGoal()?.hash||view.attemptId!==state.views[state.currentView]?.attemptId);
 host.append(section('整体目标',currentGoal()?.originalText||'尚未保存整体目标，请核对目标。'));const evidence=button('目标原文与完整依据',showOverview,'linklike');evidence.id='overview-evidence';$('overall-panel').querySelector('#overview-evidence')?.remove();$('overall-panel').append(evidence);
 if(!diagnosis){host.append(section('当前判断','尚无整体诊断。开发记录与源码差异可以先查看；已有模块结果不能证明整体旅程成立。'),section('一个优先下一步',state.closedLoop?.nextAction||(mapped?round?.next:null)||[...(view?.gaps||[])].filter(g=>g.lifecycle==='open').sort((a,b)=>a.rank-b.rank)[0]?.action||'核对目标与来源，补充匹配分析和行为证据。'));return;}
 host.append(section(stale?'历史判断 · 待核对':diagnosis.certainty==='unknown'?'当前判断 · 证据未齐':'当前判断 · 待验证假设',diagnosis.conclusion));
 host.append(section('一个优先下一步',state.closedLoop?.nextAction||(stale?'目标、来源或证据已变化，请重新检查来源后核对主线建议。':diagnosis.recommendation.action)),el('small',stale?'旧建议仅供核查':'分析建议 · 仍需验证'));
 const detail=el('details'),summary=el('summary','判断依据、竞争解释与最小验证旅程');detail.hidden=true;detail.append(summary,section('诊断范围',`${({product:'整体产品',workflow:'跨模块流程',local:'局部'})[diagnosis.scope]}：${diagnosis.scopeReason}`),section('完整判断',diagnosis.conclusion),section('主线建议',diagnosis.recommendation.action),section('为什么先做这一步',diagnosis.recommendation.reason),section('任务目的是否服务目标',diagnosis.taskAssessment.reason),section('剩余工作',diagnosis.taskAssessment.remaining));
 for(const j of diagnosis.journeys){detail.append(section(`关键旅程 · ${j.title}`,`期望：${j.expected}；实际：${j.actual}；未知：${j.uncertainty}`));references(j.refs,detail);for(const id of j.targetIds){const node=view.analysis.modules.find(m=>m.id===id);detail.append(button(node?.title||id,()=>select(node?'module':'edge',id),'source-ref'));}}
 detail.append(el('h3','支持依据'));references(diagnosis.evidence,detail);detail.append(el('h3','反证'));references(diagnosis.counterEvidence,detail);
 for(const a of diagnosis.alternatives){detail.append(section('竞争解释',a.explanation),section('如何分辨',a.discriminatingObservation));references(a.refs,detail);}
 for(const o of diagnosis.recommendation.options)detail.append(section(`${o.disposition} · ${o.subject}`,o.reason));
 detail.append(section('最小完整验证旅程',diagnosis.recommendation.verificationJourney),el('p','这是分析建议。选择、接受计划和执行授权分别记录，不会自动修改目标或代码。','muted'));host.append(detail);
}
function brief(value,limit=70){const text=String(value).replace(/\s+/g,' ').trim();return text.length>limit?text.slice(0,limit)+'…':text;}
const executionNames={waiting:'等待开发',running:'开发中',completed:'开发结束',failed:'开发失败',cancelled:'开发已取消',incomplete:'尚未结束','agent-unknown':'主代理已结束，子代理状态未知','agent-failed':'主代理已结束，子代理失败'};
const syncNames={waiting:'等待事件',following:'正在接收', 'caught-up':'已读现有事件', 'partial-line':'等待完整记录','sync-error':'同步失败',terminal:'终局已接收',unsupported:'需手工导入'};
const agentStatusNames={observing:'正在观察','parent-reported-complete':'主代理报告结束','child-unknown':'子代理状态未知','child-failed':'子代理失败',failed:'本轮失败',delegated:'已委派，轨迹未观察',waiting:'等待启动',started:'已开始',updated:'有新活动',interrupted:'已中断',reported:'已报告，未经验证',completed:'报告结束',unknown:'未知'};
const mainlineStatusNames={unmapped:'待核对关联',stale:'旧关联待核对','intent-only':'已关联 · 尚未证实产品进展','active-intent':'开发中 · 尚未证实产品进展','changed-unverified':'来源变化 · 产品结果待验证','work-failed':'开发失败 / 取消 · 产品结果未知','failed-blocked':'条件失败 / 受阻','partial-verified':'部分限定条件通过','verified-scoped':'限定条件已验证'};
const mainlineKindNames={'direct-product':'直接产品目的','support-infrastructure':'支撑 / 基础设施目的'};
const mainlineRound=id=>state?.mainline?.rounds?.find(r=>r.roundId===id);
const conditionNames={passed:'限定通过',unknown:'未知 / 缺证','environment-blocked':'环境阻塞','missing-capability':'能力缺失','behavior-failed':'行为失败'};
function showVerificationReceipt(id){
 const receipt=state?.closedLoop?.receipts?.find(r=>r.id===id),d=dialog(`独立验证回执 · ${id}`);
 if(!receipt){d.append(el('p','该回执原件不在当前可读服务投影中；保留的绑定编号仍可供核查。','muted'));return;}
 d.append(el('p',`目标 G${receipt.binding.goalVersion} · 轮次 ${receipt.binding.roundId} · ${receipt.current?'当前条件绑定':'历史条件绑定，仅供核对'}`),section('来源与条件绑定',`来源 ${receipt.binding.sourceHash}；确认 ${receipt.binding.confirmationId}；确认哈希 ${receipt.binding.confirmationHash}；开发前快照 ${receipt.binding.beforeSnapshotId}`));
 for(const check of receipt.checks){const box=el('section',undefined,'receipt-check');box.append(el('h3',`检查 ${check.id}`),el('p',`执行 ${check.startedAt} → ${check.endedAt}；退出 ${check.exitCode??'未知'}；${check.executionError||'无执行错误记录'}`,'muted'));for(const a of check.assertions)box.append(el('p',`${a.scenarioId} / ${a.criterionId}：${conditionNames[a.status]||a.status}。实际：${a.actual}。依据：${a.evidence}`));const raw=el('details');raw.append(el('summary','原始输出与检查绑定'),el('pre',`配置 ${check.configHash}\nstdout:\n${check.stdout||''}\nstderr:\n${check.stderr||''}`));box.append(raw);d.append(box);}
}
function renderRoundComparison(comparison,host){
 if(!comparison)return;const box=el('section',undefined,'alpha-comparison');box.append(el('h4','本轮前后 · 限定证据'),el('p',comparison.summary));
 box.append(el('p',comparison.sourceChanges.length?`实际来源变化：${comparison.sourceChanges.map(c=>`${({added:'新增',deleted:'删除',modified:'修改'})[c.kind]||c.kind} ${c.path}`).join('、')}。来源变化仍须验证用户结果。`:'实际来源变化：未观察到登记文件差异。','muted'));
 for(const c of comparison.criteria){const row=el('div',undefined,'comparison-condition');row.append(el('strong',c.text),el('span',`此前 ${conditionNames[c.before.status]||c.before.status} → 本轮 ${conditionNames[c.after.status]||c.after.status}${c.transition==='resolved'?' · 失败后复测通过':c.transition==='incomparable'?' · 版本不可比':c.transition==='new-evidence'?' · 首次取得限定证据':''}`));if(c.transition==='incomparable')row.append(el('small',c.reason,'muted'));box.append(row);}
 box.append(el('p',`还差：${comparison.unverified.length?comparison.unverified.join('；'):'完整用户旅程和整体目标仍须核对'}。下一步：${comparison.nextReason}`,'muted'));
 const details=el('details');details.append(el('summary','核对前后来源与原始回执'),el('p',`目标 G${comparison.goalVersion??'未知'} · 开发前来源 ${comparison.beforeSourceHash} · 本轮观察 ${comparison.afterSourceHash||'未知'} · 当前确认 ${comparison.confirmationId||'未知'}`,'muted'));
 for(const c of comparison.sourceChanges){const row=el('p',`${c.path}：${c.before||'无'} → ${c.after||'无'}`,'muted');details.append(row);if(c.after&&comparison.afterSourceHash===state?.mainline?.sourceHash)details.append(button(`查看当前来源 · ${c.path}`,()=>showSource({path:c.path,sha256:c.after,start:1,end:80}),'linklike'));}
 for(const c of comparison.criteria){details.append(el('p',`${c.text} · 此前确认 ${c.before.confirmationIds.join('、')||'未知'} · ${c.reason}`,'muted'));for(const id of [...new Set([...c.before.history.map(h=>h.receiptId),...c.after.receiptIds])])details.append(button(`查看回执 ${id}`,()=>showVerificationReceipt(id),'linklike'));}
 box.append(details);host.append(box);
}
function openMainline(journey,step,roundId){mainlineReturn=workspace;mainlineReturnRound=roundId||selectedRound;journeyId=journey;switchWorkspace('map');setModelView('mainline');if(step){select('workflow-step',step);document.querySelector(`[data-step-id="${step}"]`)?.focus({preventScroll:true});}}
function returnFromMainline(){if(mainlineReturnRound)selectedRound=mainlineReturnRound;switchWorkspace(mainlineReturn);if(mainlineReturn==='agents'&&mainlineReturnRound){const card=[...document.querySelectorAll('.agent-turn')].find(n=>n.dataset.roundId===mainlineReturnRound);card?.focus({preventScroll:true});card?.scrollIntoView?.({block:'nearest'});}}
function mainlineSummary(round,host){
 if(!round)return;
 const box=el('div',undefined,'mainline-round');box.append(badge(mainlineStatusNames[round.status]||round.status,['failed-blocked','work-failed'].includes(round.status)?'bad':['verified-scoped','partial-verified'].includes(round.status)?'good':round.status==='stale'?'warn':''));
 if(round.mapping.state==='confirmed'){
  box.append(el('p',`${mainlineKindNames[round.mapping.kind]} · ${round.mapping.journeyTitle}：${round.steps.map(s=>s.title).join('、')}`),el('p',`对应目标：${brief(round.goalClauses.join('；')||'条款未定位',150)}`,'muted'),el('p',`意图：${brief(round.mapping.reason,150)}；预期验证：${brief(round.mapping.expectedVerification,150)}`,'muted'));
  renderRoundComparison(round.comparison,box);
  const touched=[...new Set(round.steps.flatMap(s=>s.touchedPaths))];box.append(el('p',touched.length?`来源支持的触及范围：${touched.join('、')}。路径关联不证明动作因果。`:'尚无本轮与所选步骤相交的来源变化。','muted'));
  for(const step of round.steps)for(const condition of step.conditions)box.append(el('p',`${step.title} · ${condition.text}：${({passed:'限定通过',unknown:'未知','environment-blocked':'环境阻塞','missing-capability':'能力缺失','behavior-failed':'行为失败'})[condition.result]||condition.result}${condition.recovered?' · 复测恢复':''}；回执 ${condition.receiptIds.join('、')}`,'agent-proof'));
  box.append(el('p',`报告：${brief(round.reported,150)}；剩余：${brief(round.remainingGaps.length?round.remainingGaps.join('；'):round.remaining,170)}`,'muted'),el('p',`下一验证：${brief(round.nextVerification,170)}`,'muted'));
  box.append(button('查看产品主线',()=>openMainline(round.mapping.journeyId,round.steps[0]?.id,round.roundId),'linklike'),button('修订关联（保留前版）',()=>mainlineMappingForm(round.roundId),'linklike'));
 }else{
  if(round.intentSteps?.length){
   const relation=round.mapping.intentRelation;
   box.append(el('p',`${mainlineKindNames[round.mapping.kind]} · ${round.mapping.journeyTitle}：${round.intentSteps.map(s=>s.title).join('、')}`),el('p',`保存的开发意图：${brief(round.mapping.reason,180)}；预期验证：${brief(round.mapping.expectedVerification,180)}`,'muted'));
   box.append(el('p',`历史依据：分析 ${round.mapping.viewAttemptId} · 来源 ${round.mapping.sourceHash?.slice(0,12)} · 目标 G${round.mapping.referenceGoalVersion??'未知'}；本轮观察 ${round.mapping.observedSourceHash?.slice(0,12)||'未知'}。${relation==='reference-visible'?state.mainline?.status==='stale-source'?'当前源码需要重新分析；这里不显示旧条件通过。':'此注记仅为历史意图，须显式修订才可核对当前证明。':relation==='old-goal'?'目标已变，不能计入当前产品进展。':'当前分析已换版，需显式核对并重新关联；不会按相同 ID 自动套用。'}`,'muted'));
   if(relation==='reference-visible')box.append(button('查看保存的产品主线',()=>openMainline(round.mapping.journeyId,round.intentSteps[0]?.id,round.roundId),'linklike'));
   if(round.goalHash===currentGoal()?.hash&&state.mainline?.referenceViewAttemptId)box.append(button('按当前保存主线修订关联',()=>mainlineMappingForm(round.roundId),'linklike'));
  }else box.append(el('p',round.mapping.state==='stale'?'旧关联的分析或步骤无法核对，保留原件并等待重新映射。':'尚未人工确认这一轮对应哪条产品旅程；工程活动不能自动算作产品进展。','muted'));
  if(round.candidates.length)box.append(el('p',`来源候选：${round.candidates.slice(0,3).map(c=>`${c.journeyTitle} / ${c.stepTitle}`).join('、')}。需要人工核对。`,'muted'));
  box.append(el('p',`报告：${brief(round.reported,150)}；剩余：${brief(round.remaining,150)}；下一验证：${brief(round.nextVerification,150)}`,'muted'));
  renderRoundComparison(round.comparison,box);
  if(round.goalHash===currentGoal()?.hash&&state.mainline?.referenceViewAttemptId&&state.rounds?.rounds?.find(r=>r.id===round.roundId)?.after&&!round.intentSteps?.length)
   box.append(button('关联主线',()=>mainlineMappingForm(round.roundId),'linklike'));
 }
 host.append(box);
}
function renderActivity(){
 const projection=state.activity||{connections:[],turns:[],chronology:[]},sync=$('agent-sync'),turns=$('agent-turns'),events=$('agent-events'),connectionSummary=$('agent-connections-summary');
 sync.replaceChildren();turns.replaceChildren();events.replaceChildren();
 if(!projection.connections.length){connectionSummary.textContent='尚未连接开发会话';turns.append(el('p','连接已登记证据根中的单个 Codex 流后，会自动同步新事件。','muted'));return;}
 const failedConnections=projection.connections.filter(c=>c.status==='sync-error').length;
 connectionSummary.textContent=failedConnections?`连接状态与来源 · ${failedConnections} 个同步失败`:`连接状态与来源 · ${projection.connections.length} 个已登记流`;
 for(const c of projection.connections){const card=el('div',undefined,'agent-connection');card.append(badge(syncNames[c.status]||c.status,c.status==='sync-error'?'bad':''),el('strong',`${c.format==='codex-native-rollout'?'Codex 会话':'Codex exec'} · ${c.purpose}`));card.append(el('p',`${c.relevance==='bound to current goal'?'绑定当前目标':'目标已改变：须重新核对任务目的'} · ${c.start==='from-now'?'从连接时开始，之前未知':'历史回放'} · 最后收到 ${c.lastReceivedAt||'尚无新事件'}`,'muted'));card.append(el('small',c.coverage,'muted'));if(c.issue){card.append(el('p',c.issue,'conflict'),button('核对原件后重放',()=>api(endpoint('activity-replay'),{connectionId:c.id}).then(()=>refresh(true)).catch(e=>notice(e.message))));}sync.append(card);}
 for(const t of [...projection.turns].reverse()){const card=el('article',undefined,'agent-turn');card.dataset.roundId=t.roundId||'';card.tabIndex=-1;const header=el('div',undefined,'agent-turn-header');header.append(el('h3',t.purpose),badge(agentStatusNames[t.status]||t.status,t.status==='failed'?'bad':t.status==='child-unknown'?'warn':''));card.append(header);
  card.append(el('p',`任务 ${t.taskId||'未知'} · ${t.stale?'旧目标绑定，目的待核对':'关联当前目标'}：${t.goalClauses?.map(c=>c.text).join('；')||'条款未定位'} · ${t.sourceTiming}${t.sourceStale?' · 来源已变化，旧映射待核对':''} · 最新事件 ${t.latestEvent||'未知'}（${t.latestEventAt||'源未给时间'}）；本地收到 ${t.lastReceivedAt||'未知'}`,'muted'));
  const tree=el('ul',undefined,'agent-tree');for(const a of t.agents){const row=el('li',undefined,a.id==='root'?'parent':'child'),parent=t.agents.find(x=>x.id===a.parentId);row.append(el('strong',a.parentId===null&&a.id!=='root'?`${a.label}（父代理未定位）`:a.label),badge(agentStatusNames[a.status]||a.status),el('span',`${parent?`由${parent.label}委派 · `:''}${a.lastAction||'未观察到具体动作'}`));tree.append(row);}card.append(tree);
  if(t.agents.length>1&&!t.childInternalTraceObserved)card.append(el('p','只观察到子代理的委派、状态或报告；子代理内部工具轨迹未观察到。','muted'));
  card.append(el('p',t.currentAction?`最近动作：${t.currentAction}`:'具体读写或工具动作尚未观察到。'));
  card.append(el('p',t.sourcePaths.length?`登记范围内的来源路径：${t.sourcePaths.join('、')}`:'没有可安全定位到登记范围的文件路径；来源映射未知。','muted'));
  mainlineSummary(t.mainline,card);
  const links=el('div',undefined,'agent-links');if(t.roundId)links.append(button('查看开发轮次与来源变化',()=>{selectedRound=t.roundId;switchWorkspace('rounds');},'linklike'));else links.append(el('span','尚无可绑定的开发轮次（可能需要重新确认目标）。','muted'));
  for(const target of t.targets){const known=view?.analysis.modules.some(m=>m.id===target.id)?'module':view?.analysis.edges.some(e=>e.id===target.id)?'edge':null;if(known)links.append(button(`查看 ${target.label}`,()=>select(known,target.id),'linklike'));}card.append(links);
  card.append(el('p',t.verified?`所选主线步骤有 ${t.passedConditions} 项匹配条件通过；仍需核对完整目标。`:'尚无匹配所选主线步骤的独立条件通过回执；代理报告与命令退出不算产品验证。',t.verified?'agent-proof good':'agent-proof'));
  turns.append(card);
 }
 if(!projection.turns.length)turns.append(el('p','已连接，尚未观察到新轮次；历史活动和当前生产者状态未知。','muted'));
 for(const e of [...projection.chronology].reverse().slice(0,50))events.append(el('p',`${e.sourceTimestamp||'源未给时间'} · ${e.label} · ${agentStatusNames[e.status]||'状态未知'} · ${e.agentId==='root'?'主代理':'子代理'} · 本地收到 ${e.receivedAt}`,'agent-event'));
}
function connectAgentForm(){
 const d=dialog('连接一个 Codex 开发会话'),p=projects.find(x=>x.id===projectId),goal=currentGoal();if(!goal){d.append(el('p','请先保存目标，再连接开发活动。'));return;}
 const form=el('form');d.append(form);form.append(el('p','仅观察你指定的已登记证据根中的一个 JSONL 文件。已有内容默认从当前文件末尾开始；此前活动保持未知。','muted'));
 const identity=field(form,'当前工作树',el('input'));identity.value=p.sourceRoot;identity.readOnly=true;
 const branch=field(form,'当前分支',el('input'));branch.required=true;branch.placeholder='feature/my-work';
 const task=field(form,'任务简称（字母、数字、点、下划线或连字符）',el('input'));task.required=true;task.pattern='[A-Za-z0-9][A-Za-z0-9._-]*';
 const purpose=field(form,'本轮开发目的',el('textarea'));purpose.required=true;
 const format=field(form,'事件格式',el('select'));for(const [value,label] of [['codex-native-rollout','Codex 本机会话（含真实 turn_id）'],['codex-exec-jsonl','codex exec --json']]){const option=el('option',label);option.value=value;format.append(option);}
 const version=field(form,'Codex 工具版本',el('input'));version.value='0.155.0-alpha.9.2';version.required=true;
 const root=field(form,'已登记证据根',el('select'));for(const i of p.evidenceRootIndices||[]){const option=el('option',`证据根 ${i+1}`);option.value=String(i);root.append(option);}
 const path=field(form,'该证据根内的相对 JSONL 路径',el('input'));path.required=true;path.placeholder='rollout/selected-session.jsonl';
 const clauses=el('fieldset');clauses.append(el('legend','本任务直接关联的目标条款'));const checks=[];for(const clause of goal.clauses){const label=el('label',undefined,'agent-clause');const check=el('input');check.type='checkbox';check.value=clause.id;checks.push(check);label.append(check,document.createTextNode(clause.text));clauses.append(label);}form.append(clauses);
 const current=state.mainline?.status==='current'&&state.mainline.journeys.length;
 let journeyChoice=null,stepChecks=[],kind=null,reason=null,verification=null;
 if(current){
  journeyChoice=field(form,'要推进的产品旅程',el('select'));for(const j of state.mainline.journeys){const option=el('option',j.title);option.value=j.id;journeyChoice.append(option);}journeyChoice.value=state.mainline.journeys.some(j=>j.id===journeyId)?journeyId:state.mainline.journeys[0].id;
  const steps=el('fieldset');steps.append(el('legend','实际关联的步骤'));form.append(steps);
  const renderSteps=()=>{steps.replaceChildren(el('legend','实际关联的步骤'));stepChecks=[];for(const step of state.mainline.journeys.find(j=>j.id===journeyChoice.value)?.steps||[]){const label=el('label',undefined,'agent-clause'),check=el('input');check.type='checkbox';check.value=step.id;stepChecks.push(check);label.append(check,document.createTextNode(step.title));steps.append(label);}};journeyChoice.onchange=renderSteps;renderSteps();
  kind=field(form,'目的类型',el('select'));for(const [value,label] of Object.entries(mainlineKindNames)){const option=el('option',label);option.value=value;kind.append(option);}
  reason=field(form,'这项工作怎样推进该步骤 / 排除什么阻碍',el('textarea'));reason.required=true;
  verification=field(form,'什么条件验证会显示实际收益',el('textarea'));verification.required=true;
 }else form.append(el('p','当前没有同目标、同来源的产品主线分析。本连接会明确保留为「待核对关联」；分析后可逐轮人工关联。','muted'));
 const submit=el('button','连接并开始自动观察','primary');submit.type='submit';form.append(submit);
 form.onsubmit=async event=>{event.preventDefault();const selected=checks.filter(x=>x.checked).map(x=>x.value),chosenSteps=stepChecks.filter(x=>x.checked).map(x=>x.value);if(!selected.length){notice('请选择至少一项实际关联的目标条款。');return;}if(current&&!chosenSteps.length){notice('请选择实际关联的产品主线步骤。');return;}try{const mainlineIntent=current?{viewAttemptId:state.mainline.viewAttemptId,sourceHash:state.mainline.sourceHash,journeyId:journeyChoice.value,stepIds:chosenSteps,kind:kind.value,reason:reason.value,expectedVerification:verification.value}:undefined;await api(endpoint('activity-connect'),{id:`connection-${key()}`,projectId,repoRoot:p.sourceRoot,worktreeRoot:p.sourceRoot,branch:branch.value,format:format.value,toolVersion:version.value,taskId:task.value,goalHash:goal.hash,purpose:purpose.value,clauseIds:selected,journeyIds:mainlineIntent?[mainlineIntent.journeyId]:[],selectedActionIds:[],...(mainlineIntent?{mainlineIntent}:{}),stream:{rootIndex:Number(root.value),path:path.value},start:'from-now'});$('dialog').close();await refresh(true);switchWorkspace('agents');}catch(e){notice(e.message);}};
}
$('connect-agent').onclick=connectAgentForm;
function mainlineMappingForm(roundId){
 const round=mainlineRound(roundId),progress=state.mainline,goal=currentGoal(),currentView=state.views[state.currentView];
 const d=dialog('关联主线 · 保留每次修订');
 const observed=state.rounds?.rounds?.find(r=>r.id===roundId),historical=progress?.status!=='current'||observed?.after?.sourceHash!==progress?.sourceHash;
 if(!round||!goal||round.goalHash!==goal.hash||!observed?.after||!currentView||!progress?.referenceViewAttemptId||currentView.attemptId!==progress.referenceViewAttemptId||currentView.source.hash!==progress.referenceSourceHash){d.append(el('p','缺少与当前目标相符的已保存主线，或本轮没有来源观察；请先核对目标与轮次。'));return;}
 const form=el('form');d.append(form);form.append(el('p',`本轮目的：${brief(round.purpose,180)}。关联是人工解释，不修改原始事件、目标确认或验收。`,'muted'));
 if(round.mapping.annotationId||round.mapping.origin==='connection'){
  const old=el('div',undefined,'mapping-previous');old.append(el('h3','此前核对的关联'),el('p',`${round.mapping.journeyTitle||'旅程未知'} → ${round.intentSteps.map(s=>s.title).join('、')||'步骤未知'}`),el('p',`当时目标 G${round.mapping.referenceGoalVersion??'未知'} · 分析 ${round.mapping.viewAttemptId||'未知'} · 来源 ${round.mapping.sourceHash?.slice(0,12)||'未知'}`,'muted'),el('p',`理由：${round.mapping.reason||'未说明'}；预期验证：${round.mapping.expectedVerification||'未说明'}`,'muted'));form.append(old);
 }
 form.append(el('p',`现在请按当前保存的分析重新核对旅程和实际步骤。目标 G${goal.version} · 来源 ${progress.referenceSourceHash?.slice(0,12)||'未知'}。这个选择只保存开发意图，产品结果仍看独立回执。`,'mapping-current'));
 let historicalChoice=null;
 if(historical){
  form.append(el('p',`本次只把已观察轮次解释为保存分析中的开发意图：分析 ${progress.referenceViewAttemptId}、参考来源 ${progress.referenceSourceHash?.slice(0,12)}、本轮观察 ${observed.after.sourceHash.slice(0,12)}。当前来源已变化或本轮来源不同，须重新分析并验证；保存后不会产生产品进展或条件通过。`,'mainline-intent-note'));
  const label=el('label',undefined,'agent-clause'),check=el('input');check.type='checkbox';label.append(check,document.createTextNode('我确认只保存历史版本的开发意图，当前证明仍待核对'));form.append(label);historicalChoice=check;
 }
 if(round.mapping.intentRelation==='pending-remap')form.append(el('p','旧关联来自另一版分析。即使旅程或步骤 ID 相同，也请重新选择；系统不会自动沿用。','muted'));
 const journey=field(form,'本次核对的产品旅程',el('select'));if(round.mapping.intentRelation==='pending-remap'){const option=el('option','请选择当前保存分析中的旅程');option.value='';journey.append(option);journey.required=true;}for(const j of progress.journeys){const option=el('option',j.title);option.value=j.id;journey.append(option);}
 journey.value=round.mapping.intentRelation==='pending-remap'?'':progress.journeys.some(j=>j.id===round.mapping.journeyId)?round.mapping.journeyId:round.candidates[0]?.journeyId||progress.journeys[0]?.id||'';
 const steps=el('fieldset');steps.append(el('legend','本次核对的实际步骤'));form.append(steps);let checks=[];
 const renderSteps=()=>{steps.replaceChildren(el('legend','本次核对的实际步骤'));checks=[];for(const step of progress.journeys.find(j=>j.id===journey.value)?.steps||[]){const label=el('label',undefined,'agent-clause'),check=el('input');check.type='checkbox';check.value=step.id;check.checked=round.mapping.intentRelation==='reference-visible'&&round.mapping.journeyId===journey.value?round.mapping.stepIds.includes(step.id):round.candidates.some(c=>c.journeyId===journey.value&&c.stepId===step.id);checks.push(check);label.append(check,document.createTextNode(step.title));steps.append(label);}};journey.onchange=renderSteps;renderSteps();
 const kind=field(form,'目的类型',el('select'));for(const [value,label] of Object.entries(mainlineKindNames)){const option=el('option',label);option.value=value;kind.append(option);}kind.value=round.mapping.kind||'direct-product';
 const reason=field(form,'关联理由或基础设施要排除的阻碍',el('textarea'));reason.required=true;reason.value=round.mapping.reason||'';
 const verification=field(form,'预期用什么条件验证收益',el('textarea'));verification.required=true;verification.value=round.mapping.expectedVerification||'';
 const author=field(form,'核对人',el('input'));author.required=true;
 const save=el('button','确认关联并保存历史','primary');save.type='submit';form.append(save);
 const history=progress.annotations.filter(a=>a.roundId===roundId);if(history.length){const past=el('details');past.append(el('summary',`此前关联 · ${history.length} 版`));for(const a of history)past.append(el('p',`${a.createdAt} · ${a.author} · ${mainlineKindNames[a.kind]} · ${a.reason}`));d.append(past);}
 form.onsubmit=async event=>{event.preventDefault();const stepIds=checks.filter(c=>c.checked).map(c=>c.value);if(!journey.value||!stepIds.length){notice('请选择产品旅程和至少一个实际步骤。');return;}if(historical&&!historicalChoice.checked){notice('请先确认这只是历史版本的开发意图，不代表产品进展。');return;}try{await api(endpoint('mainline-annotate'),{expectedRevision:progress.revision,idempotencyKey:`mainline-${key()}`,roundId,goalHash:goal.hash,viewAttemptId:progress.referenceViewAttemptId,sourceHash:progress.referenceSourceHash,journeyId:journey.value,stepIds,kind:kind.value,reason:reason.value,expectedVerification:verification.value,previousId:history.at(-1)?.id||null,author:author.value,...(historical?{interpretationMode:'historical-intent',observedSourceHash:observed.after.sourceHash,expectedCurrentSourceHash:progress.sourceHash}:{})});$('dialog').close();await refresh(true);}catch(e){notice(e.message);}};
}
function renderRounds(){
 const host=$('round-detail'),timeline=$('round-timeline'),sync=$('round-sync');if(!host)return;const evidenceOpen=host.querySelector('.round-evidence')?.open||false,targetsOpen=host.dataset.roundId===selectedRound&&host.querySelector('.round-targets')?.open||false;host.replaceChildren();timeline.replaceChildren();sync.replaceChildren();
 const projection=state.rounds,rounds=projection?.rounds||[];
 if(!rounds.length){sync.append(el('p','尚未登记开发轮次','muted'));host.append(el('p','先登记来源与开发前快照；已有历史覆盖未知。','muted'));return;}
 if(!rounds.some(r=>r.id===selectedRound))selectedRound=rounds.at(-1).id;
 for(const r of [...rounds].reverse()){
  const b=button('',()=>{selectedRound=r.id;renderRounds();renderGraph();},`round-link ${r.id===selectedRound?'selected':''}`);
  b.setAttribute('aria-pressed',String(r.id===selectedRound));b.title=r.purpose;
  b.append(el('strong',brief(r.purpose,40)),el('small',`${executionNames[r.status]||'状态未知'} · ${r.mode==='live'?'现场记录':'历史回放'}${r.stale?' · 目标待核对':''}`));timeline.append(b);
 }
 const r=rounds.find(r=>r.id===selectedRound),registration=projection.registrations.find(x=>x.id===r.attempts.at(-1)?.registrationId);
 sync.append(el('small',syncNames[registration?.status]||'同步状态未知'));
 host.dataset.roundId=r.id;
 if(r.delayedRecovery)host.append(el('p',`${registration?.status==='sync-error'?'恢复仍有错误':registration?.recoveryThroughOffset!=null?'正在显式补读事件':registration?.syncHistory?.some(h=>h.kind==='recovered')?'事件接收已恢复':'恢复尚未完成'}；${r.sourceCoverage}`,'round-recovery'));
 const verified=r.stale||r.sourceStale||r.pending?.length||r.goalHash!==currentGoal()?.hash?[]:r.verified;
 const conditionChecks=r.conditionVerified||[],currentConditions=r.proofEligible===false?[]:r.conditionProgress?.criteria||[];
 const evidence=conditionChecks.length?`${currentConditions.filter(c=>c.status==='passed').length} 项条件通过；${currentConditions.filter(c=>c.status!=='passed').length} 项失败或未知${verified.some(e=>e.result==='failed')?'；旧范围验证仍失败':''}，整体待核对`:verified.some(e=>e.result==='failed')?'限定验证失败':verified.some(e=>e.result==='passed')?'已有限定验证，整体待核对':'尚无合格行为验证';
 host.append(el('h2',brief(r.purpose,80)),el('p',`${executionNames[r.status]||'状态未知'} · ${r.after?`${r.deltas.length} 项文件变化（截至最近观察）`:'尚无本轮源码观察，变化未知'} · ${evidence}`,'round-summary'));
 mainlineSummary(mainlineRound(r.id),host);
 const verification=el('div',undefined,'round-verification');verification.setAttribute('aria-label','本轮限定验证');
 const namedView=[...(state.roundViews||[]),...(state.views||[])].find(v=>v.attemptId===r.viewAttemptId&&v.source.hash===r.after?.sourceHash&&v.goal?.hash===r.goalHash);
 for(const e of [...verified].sort((a,b)=>({failed:0,unknown:1,passed:2})[a.result]-({failed:0,unknown:1,passed:2})[b.result])){
  const names=e.targetIds.map(id=>namedView?.analysis.modules.find(m=>m.id===id)?.title||namedView?.analysis.edges.find(edge=>edge.id===id)?.label||`未定位对象（${id}）`);
  const row=el('div',undefined,`scoped-check ${e.result}`);row.append(el('strong',`${({passed:'通过',failed:'失败',unknown:'未知'})[e.result]} · ${names.join('、')||'对象未说明'}`),el('p',brief(e.scopeSummary||'验证范围说明未提供',220)),el('small',`限制：${brief(e.limitations?.length?e.limitations.join('；'):'未提供限制说明，不代表无范围限制',180)}`));verification.append(row);
 }
 verification.append(el('p',verified.length||conditionChecks.length?'仍待确认：限定检查不证明整体旅程或人的使用效果；完整范围与原件见本轮证据。':r.stale?'仍待确认：旧目标的验证仅供历史核查，不能计入当前目标进展。':'仍待确认：尚无匹配本轮来源、目标和行为范围的合格证据；代理报告和文件变化不计为验证进展。','muted'));
 for(const c of r.conditionProgress?.criteria||[])verification.append(section(`验收条件 · ${c.text}`,`${r.conditionProgress.status==='stale'?'绑定已过时 / 待补齐，历史结果：':''}${({passed:'通过','environment-blocked':'环境阻塞','missing-capability':'明确能力缺失','behavior-failed':'行为失败',unknown:'未知 / 缺证'})[c.status]||c.status}${c.recovered?' · 复测恢复':''} · ${c.evidence.map(e=>e.receiptId).join(', ')||'无条件回执'}`));
 verification.append(section('剩余条件与当前阻碍',r.remaining));
 for(const g of r.conditionProgress?.gapProgress||[])verification.append(section(`差距 ${g.gapId}`,`${g.verified&&r.proofEligible!==false?'对应确认条件已验证':'仍需条件验证'}；分析报告状态 ${g.reported}`));
 host.append(verification);const digest=el('div',undefined,'round-digest');digest.append(section('为什么做',brief(r.purpose,180)),section('实际变化',r.after?`${r.deltas.length} 项文件变化；${brief(r.reported,160)}`:'尚无本轮源码观察'),section('证实了什么',evidence),section('优先下一步',brief(r.next,180)));host.append(digest);
 host.append(el('p',`最近源码观察：${r.lastSourceObservedAt||'尚未观察'}；检查点比较不证明某条命令造成变化。`,'muted'));
 if(r.stale)host.append(el('p','目标已改变，需核对本轮目的。','muted'));
 const job=state.roundAnalysis?.jobs?.filter(j=>j.roundIds.includes(r.id)).at(-1);
 if(job?.state==='pending')host.append(button('取消待分析请求',()=>api(endpoint('cancel'),{attemptId:job.id}).then(()=>refresh(true)).catch(e=>notice(e.message))));
 if(job){host.append(el('p',`本轮评估：${({pending:'等待分析',running:'正在分析',completed:'分析已结束',failed:'分析失败，原记录保留',cancelled:'已取消，不自动重启',interrupted:'已中断，需显式恢复'})[job.state]}${job.error?' · '+brief(job.error,100):''}`,'muted'));}
 const mapped=!!selectedRoundView(r.id);
 host.append(el('p',mapped?'本轮有同源且目标匹配的历史分析，可单独查看。':'映射待更新：本轮尚无匹配来源与目标的分析；当前项目图保持不变。','round-mapping'));
 if(mapped){const openMap=button('查看本轮历史图',()=>switchWorkspace('map',r.id));openMap.id='round-map';host.append(openMap);}
 if(mapped&&r.touchedTargets.length){const targets=el('details',undefined,'round-targets');targets.open=targetsOpen;targets.append(el('summary',`查看 ${r.touchedTargets.length} 个受影响模块与连接（图中已着色）`));for(const id of r.touchedTargets){const roundView=selectedRoundView(r.id),node=roundView.analysis.modules.find(m=>m.id===id),edge=roundView.analysis.edges.find(e=>e.id===id);targets.append(button(node?.title||edge?.label||'关联对象',()=>{switchWorkspace('map',r.id);select(node?'module':'edge',id);},'round-target'));}host.append(targets);}
 const detail=el('details',undefined,'round-evidence');detail.open=evidenceOpen;detail.append(el('summary','展开本轮证据、原文与文件变化'));
 detail.append(section('为什么做',r.purpose),section('目的与当前目标',r.relevance),section('人的计划接受原文',r.acceptedPlan?`${r.acceptedPlan.originalText}（${r.acceptedPlan.author}；${r.acceptedPlan.provenance}）`:'未登记人的计划接受；建议选择不等于接受'),section('原始反馈',state.feedback.filter(f=>r.feedbackIds.includes(f.id)).map(f=>f.originalText)),section('代理报告与验证结果',r.reported));
 detail.append(section('实际验证',r.verified.length?r.verified.map(e=>`${({passed:'通过',failed:'失败',unknown:'未知'})[e.result]} · ${e.scopeSummary||'验证范围说明未提供'} · 限制：${e.limitations?.length?e.limitations.join('；'):'未提供限制说明，不代表无范围限制'} · 对象 ${e.targetIds.join('、')} · 条款 ${e.clauseIds.join('、')} · 原件 ${e.rawHash}`):'尚无匹配本轮来源、目标和行为范围的合格证据；不计产品进展'));
 detail.append(section('事件读取策略',`单条上限 ${projection.eventReadPolicy?.maxRecordBytes??256000} 字节；批次上限 2000000 字节；须显式回放恢复`),section('同步中断与恢复记录',r.attempts.flatMap(a=>(a.syncHistory||[]).map(h=>`${a.registrationId} · ${h.kind} · ${h.at} · 游标 ${h.cursor} / 行 ${h.line} / 偏移 ${h.offset} · 上限 ${h.maxRecordBytes??'旧记录未保存'} · ${h.issue||'原错误保留在历史'} · 前缀 ${h.prefixHash}`))));
 detail.append(section('开发前后来源',`${r.before.sourceHash} → ${r.after?.sourceHash||'尚未捕获'}；最近源码观察 ${r.lastSourceObservedAt||'未知'}；${r.mode==='historical-replay'?'历史回放不会自动补造当时源码。':''}读取范围：${r.before.coverage.join('、')}`));
 const changes=el('div');changes.append(el('h3',r.after?`实际文件变化 · ${r.deltas.length} 项`:'实际文件变化 · 尚无本轮源码观察'));
 for(const f of r.deltas){const row=el('div',undefined,'delta-row');row.append(el('span',`${({added:'新增',deleted:'删除',modified:'修改'})[f.kind]} · ${f.path}`),el('small',`${f.before||'无'} → ${f.after||'无'}`));if(f.after)row.append(button('查看当前来源',()=>showSource({path:f.path,sha256:f.after,start:1,end:80}),'source-ref'));changes.append(row);}detail.append(changes);
 detail.append(section('模块与连接影响',r.mapping),section('剩余工作',r.remaining),section('下一轮优先动作',r.next));
 if(r.deferredBenefit)detail.append(section('基础设施延期收益',`阻碍：${r.deferredBenefit.blocker}；预期收益：${r.deferredBenefit.payoff}；验证里程碑：${r.deferredBenefit.milestone}；复查条件：${r.deferredBenefit.revisitWhen}。收益尚未计入。`));
 const p=projection.policy;detail.append(section('连续进展观察规则',`${p.signal}。窗口 ${p.window} 轮，无验证阈值 ${p.noProofThreshold}，新增字节调查阈值 ${p.addedBytesThreshold}；覆盖${p.coverageComplete?'完整':'不足'}。规则 ${p.version}。`));
 detail.append(section('轮次身份',`${r.id} · 任务 ${r.taskId} · 目标 ${r.goalHash}`),section('尝试与恢复',r.attempts.map(a=>`${a.id} · ${executionNames[a.outcome]||'尚未结束'} · ${syncNames[a.status]}${a.issue?' · '+a.issue:''}`)));
 for(const x of projection.registrations.filter(x=>r.attempts.some(a=>a.registrationId===x.id)))detail.append(section('同步证据',`${x.id} · ${syncNames[x.status]} · 连续 ${x.cursor} / 已读 ${x.line} · ${x.issue||x.coverage} · 最近接收 ${x.lastReceivedAt||'未观察'} · 最近检查 ${x.lastCheckedAt||'未观察'} · 积压未知`));
 if(job)detail.append(section('分析绑定',`${job.id} · 来源 ${job.sourceHash} · 目标 ${job.goalHash} · ${job.error||'原件按绑定保留'}`));
 host.append(detail);
}

function showOverview(){const d=dialog('目标原文与判断依据');d.append(section('整体目标原文',currentGoal()?.originalText),section('程序理解',view?.analysis.purpose),button('目标条款与模块映射',()=>{$('dialog').close();document.querySelector('.goal-evidence').open=true;}));const detail=$('overall-diagnosis').querySelector('details');if(detail){const copy=detail.cloneNode(true);copy.hidden=false;copy.open=true;d.append(copy);const originals=[...detail.querySelectorAll('button')];copy.querySelectorAll('button').forEach((b,i)=>b.onclick=()=>originals[i].click());}else d.append(section('当前判断',$('overall-diagnosis').textContent));}
for(const name of ['map','rounds','agents']){const tab=$('tab-'+name);tab.onclick=()=>switchWorkspace(name);tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=['map','rounds','agents'],i=tabs.indexOf(name),next=event.key==='Home'?'map':event.key==='End'?'agents':tabs[(i+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];switchWorkspace(next);$('tab-'+next).focus();}};}
$('graph-wrap').onkeydown=event=>{if(event.target!==$('graph-wrap'))return;const moves={ArrowLeft:[70,0],ArrowRight:[-70,0],ArrowUp:[0,70],ArrowDown:[0,-70]};if(moves[event.key]){event.preventDefault();pan.x+=moves[event.key][0];pan.y+=moves[event.key][1];applyPan();savePref();}else if(event.key==='Home'){event.preventDefault();resetMap();}else if(['+','-','='].includes(event.key)){event.preventDefault();$('zoom-'+(event.key==='-'?'out':'in')).click();}};

function resetMap(){selection=null;$('search').value='';document.body.classList.remove('inspector-open');renderGraph();renderGaps();fit();savePref();}

// A separately bound user-workflow projection; legacy module arrays never become steps.
const relationshipNames={'call':'调用','data-flow':'数据传递','dependency':'依赖','event':'事件','control-flow':'控制关系','unclassified':'未分类'};
const flowNames={sequence:'先后',branch:'条件分支',feedback:'反馈'};
const groundingNames={'source-supported':'源码支持 · 未验证运行',unknown:'未知',proposed:'期望 / 拟需'};
function relationshipLabel(e){return `${relationshipNames[e.kind]||'未分类'} · ${groundingNames[e.certainty]||'历史关系，含义未核查'}`;}
function setModelView(name){modelView=name;$('mainline-panel').hidden=name!=='mainline';$('map-panel').hidden=name!=='implementation';for(const key of ['mainline','implementation'])$('view-'+key).setAttribute('aria-pressed',String(key===name));if(name==='implementation')renderGraph();}
$('view-mainline').onclick=()=>{setModelView('mainline');document.body.classList.remove('inspector-open');selection=null;renderWorkflow();};
$('view-implementation').onclick=()=>setModelView('implementation');
function renderProposed(){const host=$('proposed-capabilities');host.replaceChildren();const nodes=view?.analysis.modules.filter(m=>m.kind==='proposed')||[];if(!nodes.length)return;const box=el('details');box.append(el('summary',`拟需能力 · ${nodes.length}（未定位，不属于已有实现图）`));for(const n of nodes)box.append(button(n.title,()=>select('module',n.id),'text-item'));host.append(box);}
function workflowCoordinates(flow){
 // SCC condensation places cycles at one depth; feedback does not force forward rank.
 const adjacency=new Map(flow.steps.map(s=>[s.id,[]]));
 for(const e of flow.links)if(e.kind!=='feedback'&&adjacency.has(e.from)&&adjacency.has(e.to))adjacency.get(e.from).push(e.to);
 const indices=new Map(),low=new Map(),stack=[],active=new Set(),components=[];let index=0;
 function visit(id){indices.set(id,index);low.set(id,index++);stack.push(id);active.add(id);for(const next of adjacency.get(id)){if(!indices.has(next)){visit(next);low.set(id,Math.min(low.get(id),low.get(next)));}else if(active.has(next))low.set(id,Math.min(low.get(id),indices.get(next)));}if(low.get(id)===indices.get(id)){const group=[];let item;do{item=stack.pop();active.delete(item);group.push(item);}while(item!==id);components.push(group);}}
 for(const s of flow.steps)if(!indices.has(s.id))visit(s.id);
 const owner=new Map();components.forEach((c,i)=>c.forEach(id=>owner.set(id,i)));const degree=components.map(()=>0),ranks=components.map(()=>0),edges=components.map(()=>new Set());
 for(const e of flow.links){const a=owner.get(e.from),b=owner.get(e.to);if(e.kind!=='feedback'&&a!==b&&a!==undefined&&b!==undefined&&!edges[a].has(b)){edges[a].add(b);degree[b]++;}}
 const queue=degree.flatMap((n,i)=>n===0?[i]:[]);for(const a of queue)for(const b of edges[a]){ranks[b]=Math.max(ranks[b],ranks[a]+1);if(--degree[b]===0)queue.push(b);}
 const rows=new Map(),coords=new Map();for(const s of flow.steps){const rank=ranks[owner.get(s.id)],row=rows.get(rank)||0;rows.set(rank,row+1);coords.set(s.id,{x:16+rank*230,y:24+row*153});}return coords;
}
function workflowLayout(flow){
 const coords=workflowCoordinates(flow),nodeWidth=190,nodeHeight=133;
 const bottom=Math.max(24,...[...coords.values()].map(p=>p.y+nodeHeight));let lane=0;
 const links=flow.links.flatMap(link=>{
  const from=coords.get(link.from),to=coords.get(link.to);if(!from||!to)return [];
  const x1=from.x+nodeWidth,y1=from.y+nodeHeight/2,x2=to.x,y2=to.y+nodeHeight/2;
  // Only adjacent forward ranks use the gap. Feedback, cycles and long edges
  // take separate lanes below the nodes, never through an intervening step.
  const routed=link.kind==='feedback'||to.x-from.x!==230;
  const y=bottom+28+lane*36;if(routed)lane++;
  const d=routed?`M${x1} ${y1} H${x1+8} V${y} H${x2-8} V${y2} H${x2}`:`M${x1} ${y1} C${x1+20} ${y1} ${x2-20} ${y2} ${x2} ${y2}`;
  return [{link,d,routed,labelX:(x1+x2)/2,labelY:routed?y-7:(y1+y2)/2-10}];
 });
 return {coords,links,nodeWidth,nodeHeight,width:Math.max(240,...[...coords.values()].map(p=>p.x+nodeWidth+16)),height:bottom+26+lane*36};
}
function renderWorkflow(){
 const host=$('workflow-content');host.replaceChildren();const workflow=view?.analysis.workflow;
 const heading=el('div',undefined,'workflow-heading');heading.append(el('h2','产品主线'));host.append(heading);
 if(!workflow){host.append(el('p','未建立工作主线：当前分析只有实现关系，不能据模块排列推定工作顺序。'),button('检查实现关系',()=>setModelView('implementation')));return;}
 if(!workflow.journeys.some(j=>j.id===journeyId))journeyId=workflow.journeys[0]?.id;
 const choice=el('select');choice.id='workflow-journey';choice.setAttribute('aria-label','选择目标旅程');for(const j of workflow.journeys){const option=el('option',j.title);option.value=j.id;choice.append(option);}choice.value=journeyId||'';choice.onchange=()=>{journeyId=choice.value;renderWorkflow();$('workflow-journey').focus();};heading.append(choice);
 const journey=workflow.journeys.find(j=>j.id===journeyId);
 if(journey){const purpose=el('p',journey.purpose,'workflow-purpose');purpose.title=journey.purpose;host.append(purpose);}
 const referenceVisible=!historicalRound&&state.mainline?.referenceViewAttemptId===view?.attemptId&&state.mainline?.referenceSourceHash===view?.source.hash;
 const journeyProgress=referenceVisible?state.mainline.journeys.find(j=>j.id===journeyId):null;
 if(referenceVisible&&state.mainline.status==='stale-source')host.append(el('p',`这是保存的主线分析（来源 ${view.source.hash.slice(0,12)}）；当前源码 ${state.mainline.sourceHash.slice(0,12)} 已变化。步骤和关联只说明开发意图，来源待重新分析，旧条件通过不能算当前产品进展。`,'mainline-intent-note'));
 if(journeyProgress){const feed=el('section',undefined,'mainline-feed');feed.append(el('h3',state.mainline.status==='current'?'本旅程开发进展':'本旅程保存的开发意图 · 来源待复查'));if(!journeyProgress.feed.length){feed.append(el('p','尚无已确认关联的开发轮次；现有活动不能自动计为产品进展。','muted'));const candidate=state.mainline.rounds.find(r=>r.mapping.state==='unknown'&&r.candidates.some(c=>c.journeyId===journeyId));if(candidate)feed.append(button('核对候选轮次关联',()=>mainlineMappingForm(candidate.roundId),'linklike'));}else for(const item of journeyProgress.feed){const row=el('div',undefined,'mainline-feed-row');row.append(badge(mainlineStatusNames[item.status]||item.status),el('span',`${brief(item.purpose,52)} · ${item.stepTitles.join('、')} · ${brief(item.reason||'开发意图未说明',100)} · 预期验证：${brief(item.nextVerification,100)}`),button('查看轮次',()=>{selectedRound=item.roundId;switchWorkspace('rounds');},'linklike'));feed.append(row);renderRoundComparison(item.comparison,feed);}feed.append(el('p',`下一验证：${brief(journeyProgress.nextVerification,180)}`,'mainline-next'));if(mainlineReturn!=='map')feed.append(button(mainlineReturn==='agents'?'返回实时开发':'返回开发轮次',returnFromMainline,'linklike'));host.append(feed);}
 if(workflow.status==='unknown')host.append(el('p','未建立工作主线；下面仅为已定位片段和待核对步骤。','conflict'));
 const cue=el('p','实线：源码支持，未验证运行；虚线：未知。＊有条件，选择箭头可读。超出画布可横向 / 纵向滚动。','workflow-cue');cue.id='workflow-cue';host.append(cue);
 if(journey){const flow=journey.observed;
 const {coords,links,nodeWidth,nodeHeight,width,height}=workflowLayout(flow);
 const scroll=el('div',undefined,'workflow-canvas');scroll.id='workflow-scroll';scroll.tabIndex=0;scroll.setAttribute('aria-label','实际工作步骤；方向键滚动画布，或使用下方文字路径');scroll.setAttribute('aria-describedby','workflow-cue');
 scroll.onkeydown=e=>{if(e.target!==scroll)return;const delta={ArrowRight:[80,0],ArrowLeft:[-80,0],ArrowDown:[0,80],ArrowUp:[0,-80]}[e.key];if(delta){e.preventDefault();scroll.scrollLeft+=delta[0];scroll.scrollTop+=delta[1];}};
 const svg=svgEl('svg',{width,height,role:'group','aria-label':'实际工作主线'}),defs=svgEl('defs'),marker=svgEl('marker',{id:'workflow-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto'});marker.append(svgEl('path',{d:'M0 0 L10 5 L0 10z',fill:'currentColor'}));defs.append(marker);svg.append(defs);
 for(const {link,d,routed,labelX,labelY}of links){
 const label=`${flowNames[link.kind]} · 条件：${link.condition} · ${link.meaning} · ${groundingNames[link.state]}`;
 const group=svgEl('g',{'data-flow-link':link.id,class:`workflow-link ${link.kind} ${link.state}`,tabindex:0,role:'button','aria-label':label});const title=svgEl('title');title.textContent=label;
 group.append(title,svgEl('path',{d,class:'workflow-hit'}),svgEl('path',{d,'marker-end':'url(#workflow-arrow)'}));const text=svgEl('text',{x:labelX,y:labelY,'text-anchor':'middle'});text.textContent=(link.kind==='branch'?'分支':flowNames[link.kind])+(link.condition?'＊':'')+(routed&&link.condition?' '+wrap(link.condition,Math.max(6,Math.min(20,(Math.abs(coords.get(link.from).x+nodeWidth-coords.get(link.to).x)-60)/12)),1)[0]:'');group.append(text);
 runtimeBadge(group,link.targetIds||[],link.clauseIds||[],labelX,routed?labelY+19:Math.max(coords.get(link.from).y,coords.get(link.to).y)+nodeHeight+18,true);group.onclick=()=>select('workflow-link',link.id);group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select('workflow-link',link.id);}};svg.append(group);}
 for(const step of flow.steps){const p=coords.get(step.id),work=journeyProgress?.steps.find(s=>s.id===step.id)?.work||[],progress=work.at(-1)?.status||'unmapped',group=svgEl('g',{transform:`translate(${p.x} ${p.y})`,class:`workflow-step ${step.state} progress-${progress}`,tabindex:0,role:'button','data-step-id':step.id,'data-mainline-status':progress,'aria-label':`${step.title} · ${groundingNames[step.state]} · ${mainlineStatusNames[progress]||'尚无关联开发轮次'} · 输出 ${step.outputs.join('；')}`});const title=svgEl('title');title.textContent=`${step.title} · ${mainlineStatusNames[progress]||'尚无关联开发轮次'}`;group.append(title,svgEl('rect',{width:nodeWidth,height:nodeHeight,rx:10}));for(const [line,i]of wrap(step.title,11.5,2).entries()){const t=svgEl('text',{x:12,y:25+line*22});t.textContent=i;group.append(t);}for(const [text,y]of [[groundingNames[step.state],72],['输出：'+step.outputs.join('；'),92]]){const t=svgEl('text',{x:12,y,class:'workflow-meta'});t.textContent=wrap(text,13.5,1)[0];group.append(t);}runtimeBadge(group,step.targetIds,step.clauseIds,12,109);const marker=svgEl('text',{x:12,y:126,class:'workflow-progress'});marker.textContent=work.length?`${({unmapped:'待核对关联',stale:'历史意图 · 来源待复查','intent-only':'已关联待验','active-intent':'开发中待验','changed-unverified':'来源变化待验','work-failed':'开发失败 / 取消','failed-blocked':'失败 / 阻塞','partial-verified':'部分条件通过','verified-scoped':'限定条件通过'})[progress]||progress} · ${work.length} 轮`:'开发关联待核对';group.append(marker);group.onclick=()=>select('workflow-step',step.id);group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select('workflow-step',step.id);}};svg.append(group);}
 scroll.append(svg);host.append(scroll);
 }
 const basis=el('details');basis.id='workflow-basis';basis.append(el('summary',`分析说明与范围 · ${workflow.coverage==='partial'?'部分来源':'已读登记范围'}`),el('small',`本图目标 ${view.goal?`G${view.goal.version}`:'未提供'} · 来源 ${view.source.hash.slice(0,12)} · ${historicalRound?'历史核查':state.mainline?.status==='stale-source'?'保存分析 · 当前源码待复查':'当前发布分析'}`,'muted'),el('p','按用户结果阅读实际步骤；连线说明条件与传递。静态来源不等于运行验证。'),el('p',workflow.summary),badge(workflow.coverage==='partial'?'部分来源 · 整体仍需补查':'已读登记范围 · 非全项目证明'));
 if(journey)basis.append(section('要达成的结果',journey.purpose));host.append(basis);
 if(journey){const flow=journey.observed;
 const words=el('details');words.id='workflow-text';words.append(el('summary','完整步骤与连线文字路径'));
 for(const step of flow.steps){words.append(button(`${step.title} · ${groundingNames[step.state]} · 输出：${step.outputs.join('；')} · 当前：${step.actual}`,()=>select('workflow-step',step.id),'text-item'));for(const link of flow.links.filter(l=>l.from===step.id)){const to=flow.steps.find(s=>s.id===link.to);words.append(button(`${step.title} → ${to?.title||link.to}：${flowNames[link.kind]}；条件：${link.condition}；${link.meaning}；${groundingNames[link.state]}`,()=>select('workflow-link',link.id),'text-item'));references(link.refs,words);}}
 host.append(words);
 const desired=el('details');desired.id='workflow-desired';desired.append(el('summary',`期望流程 / 拟需步骤 · ${journey.desired.steps.length}（不属于已有流程）`));for(const step of journey.desired.steps)desired.append(button(`${step.title} · ${groundingNames[step.state]} · ${step.purpose}`,()=>select('workflow-step',step.id),'text-item'));for(const link of journey.desired.links)desired.append(el('p',`${link.from} → ${link.to} · ${flowNames[link.kind]} · ${link.condition} · ${link.meaning} · ${groundingNames[link.state]}`));host.append(desired);
 }
 const unknown=el('details');unknown.id='workflow-unknowns';unknown.append(el('summary',`未确定范围 · ${workflow.unknowns.length}`));for(const item of workflow.unknowns)unknown.append(el('p',item));host.append(unknown);
}
function renderWorkflowLink(id,host){
 const journey=view.analysis.workflow?.journeys.find(j=>j.observed.links.some(l=>l.id===id));if(!journey)return;
 const link=journey.observed.links.find(l=>l.id===id),steps=journey.observed.steps;
 $('detail-title').textContent=`${steps.find(s=>s.id===link.from)?.title||link.from} → ${steps.find(s=>s.id===link.to)?.title||link.to}`;
 runtimeBadge(host,link.targetIds||[],link.clauseIds||[]);host.append(badge(flowNames[link.kind]),badge(groundingNames[link.state]),section('条件',link.condition),section('传递与含义',link.meaning));references(link.refs,host);
 for(const id of [link.from,link.to])host.append(button(steps.find(s=>s.id===id)?.title||id,()=>select('workflow-step',id),'text-item'));
}
function renderWorkflowStep(id,host){
 const journey=view.analysis.workflow?.journeys.find(j=>[...j.observed.steps,...j.desired.steps].some(s=>s.id===id));if(!journey)return;
 const step=[...journey.observed.steps,...journey.desired.steps].find(s=>s.id===id);$('detail-title').textContent=step.title;
 runtimeBadge(host,step.targetIds,step.clauseIds);host.append(badge(groundingNames[step.state]),section('目的',step.purpose),section('负责者与职责',`${step.actor} · ${step.responsibility}`),section('输入',step.inputs),section('输出',step.outputs),section('当前来源显示',step.actual),section('尚未确定',step.uncertainty));
 const clauses=step.clauseIds.map(id=>view.goal?.clauses.find(c=>c.id===id)?.text||id);host.append(section('对应目标',clauses));references(step.refs,host);
 host.append(el('h3','实现映射'));if(!step.targetIds.length)host.append(el('p','尚未定位实现，不等于能力不存在。'));for(const id of step.targetIds){const m=view.analysis.modules.find(m=>m.id===id),e=view.analysis.edges.find(e=>e.id===id);host.append(button(m?.title||e?.label||id,()=>select(m?'module':'edge',id),'text-item'));}
 for(const g of view.gaps.filter(g=>g.lifecycle==='open'&&g.targetIds.some(id=>step.targetIds.includes(id))))host.append(button(`相关差距：${g.expected}`,()=>select('gap',g.id),'text-item'));
 const progress=!historicalRound&&state.mainline?.referenceViewAttemptId===view.attemptId&&state.mainline?.referenceSourceHash===view.source.hash?state.mainline.journeys.find(j=>j.id===journey.id)?.steps.find(s=>s.id===id):null;
 if(progress?.work.length){host.append(el('h3','相关开发轮次'));for(const work of [...progress.work].reverse()){const round=mainlineRound(work.roundId);host.append(badge(mainlineStatusNames[work.status]||work.status),button(`查看轮次：${brief(round?.purpose||'开发目的未登记',70)}`,()=>{selectedRound=work.roundId;switchWorkspace('rounds');},'text-item'));if(round?.turnId)host.append(button('查看实时活动',()=>{switchWorkspace('agents');const card=[...document.querySelectorAll('.agent-turn')].find(n=>n.dataset.roundId===work.roundId);card?.focus({preventScroll:true});card?.scrollIntoView?.({block:'nearest'});},'linklike'));for(const condition of round?.steps.find(s=>s.id===id)?.conditions||[])host.append(el('p',`${condition.text}：${({passed:'限定通过',unknown:'未知','environment-blocked':'环境阻塞','missing-capability':'能力缺失','behavior-failed':'行为失败'})[condition.result]||condition.result} · 回执 ${condition.receiptIds.join('、')}`,'muted'));}}
 host.append(button('核对整体目标',()=>wholeForm()),button('查看实际开发轮次',()=>switchWorkspace('rounds')));
}

// Runtime evidence is a separate layer. Never borrow current evidence into a historical view.
function runtimeCoverage(targetIds=[],clauseIds=[]){
 const loop=state?.closedLoop,available=!historicalRound&&view&&view.goal?.hash===currentGoal()?.hash&&view.source.hash===loop?.sourceHash;
 const criteria=available?(loop.criteria||[]).filter(c=>c.targetIds.some(t=>targetIds.includes(t))&&c.clauseIds.some(id=>clauseIds.includes(id))):[];
 const covered=targetIds.length&&clauseIds.length&&targetIds.every(t=>clauseIds.every(id=>criteria.some(c=>c.targetIds.includes(t)&&c.clauseIds.includes(id)&&c.mapping==='mapped')));
 const pass=criteria.filter(c=>c.status==='passed').length,failed=criteria.some(c=>!['passed','unknown'].includes(c.status));
 const status=!available?'unavailable':failed?(pass?'mixed':'failed'):covered&&criteria.length&&criteria.every(c=>c.status==='passed')?'passed':pass?'partial':'unknown';
 return {targetIds,clauseIds,criteria,status,label:({unavailable:'运行：当前证据不适用',mixed:'运行：通过与失败并存',failed:'运行：条件失败 / 阻塞',passed:'运行：映射条件通过',partial:'运行：部分通过',unknown:'运行：未知 / 未覆盖'})[status]};
}
function targetClauses(id){return [...new Set((view?.analysis.alignments||[]).filter(a=>a.targetIds.includes(id)).flatMap(a=>a.clauseIds))];}
function runtimeBadge(host,targetIds,clauseIds,x,y,compact=false){
 const coverage=runtimeCoverage(targetIds,clauseIds),open=e=>{e?.stopPropagation();showVerification(coverage);};
 if(x!==undefined){const g=svgEl('g',{class:'runtime-badge',tabindex:0,role:'button','data-runtime-status':coverage.status,'data-runtime-targets':targetIds.join(','),'aria-label':coverage.label});
 const t=svgEl('text',{x,y,...(compact?{'text-anchor':'middle'}:{})});t.textContent=compact?({unavailable:'验：不适用',mixed:'验：冲突',failed:'验：失败',passed:'验：通过',partial:'验：部分',unknown:'验：未知'})[coverage.status]:coverage.label;const title=svgEl('title');title.textContent=coverage.label;g.append(title,t);g.onclick=open;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(e);}};host.append(g);
 }else {const b=button(coverage.label,open,'runtime-badge');b.dataset.runtimeStatus=coverage.status;host.append(b);}
}

// Scenario drafts stay in the open dialog while background polling updates state.
function renderClosedLoop(){
 let host=$('closed-loop-summary');if(!host){host=el('div',undefined,'closed-loop-summary');host.id='closed-loop-summary';$('overall-panel').append(host);}host.replaceChildren();
 const loop=state?.closedLoop,confirmed=loop?.confirmation;
 host.append(el('span',loop?.status==='verified'?'确认的关键条件已有范围验证':confirmed?'关键场景仍有未验证或失败条件':'场景与验收条件待确认'),button('核对场景与条件',showScenarios),button('实际验证与调用',()=>showVerification()));
 if(loop){const p=el('p',loop.priorityReason,'muted');host.append(p);}
}
function showScenarios(){
 editing=true;const host=dialog('核对场景与可观察的验收条件'),goal=currentGoal(),generation=state.generation,proposal=[...(state.scenarioSets||[])].reverse().find(p=>p.status==='proposed'&&p.goalHash===goal?.hash&&p.analysisAttemptId===view?.attemptId),confirmed=state.closedLoop?.confirmation;
 const baseline=confirmed||proposal;
 host.append(section('人类目标原文',goal?.originalText||'尚未提供目标'),el('p','模型提议尚未确认。编辑后一次确认；已有人工确认优先保留，重分析不会替换人工文字。'));
 if(!baseline){host.append(el('p','当前目标尚无可核对的新场景提议。请先重新分析。'),button('重新分析',()=>submit('analyze',{}).catch(()=>{})));return;}
 if(confirmed)host.append(section('已保存的确认',`G${confirmed.goalVersion} · ${confirmed.author} · ${confirmed.createdAt}；来源 ${confirmed.sourceHash}。本次确认绑定当前已分析来源。`));
 let draft=JSON.parse(JSON.stringify(baseline.scenarios));const fields=el('div');host.append(fields);
 const emptyMapping=()=>({clauseIds:[],journeyIds:[],targetIds:[],mapping:'unknown',uncertainty:'尚未核对映射'});
 const newCriterion=()=>({id:`criterion-${key()}`,text:'新验收条件',observable:'填写可观察的结果',...emptyMapping()});
 const labels=(ids,kind)=>ids.map(id=>kind==='clause'?goal?.clauses.find(c=>c.id===id)?.text||id:kind==='journey'?view?.analysis.workflow?.journeys.find(j=>j.id===id)?.title||id:view?.analysis.modules.find(m=>m.id===id)?.title||view?.analysis.edges.find(e=>e.id===id)?.label||id).join('；')||'尚未映射';
 const renderDraft=()=>{fields.replaceChildren();for(const scenario of draft){const group=el('fieldset');group.append(el('legend',scenario.id));fields.append(group);
  const edit=(container,label,obj,k)=>{const t=field(container,label,el('textarea'));t.value=obj[k];t.oninput=()=>{obj[k]=t.value;};};
  edit(group,'场景名称',scenario,'title');edit(group,'前提',scenario,'given');edit(group,'用户动作',scenario,'when');edit(group,'可见结果',scenario,'then');
  const critical=field(group,'重要性',el('select'));for(const [v,label] of [['critical','关键旅程'],['supporting','支持场景']]){const o=el('option',label);o.value=v;critical.append(o);}critical.value=scenario.critical;critical.onchange=()=>scenario.critical=critical.value;
  for(const criterion of scenario.criteria){const row=el('div',undefined,'criterion-editor');group.append(row);edit(row,`验收条件 ${criterion.id}`,criterion,'text');edit(row,'怎样观察是否达到',criterion,'observable');row.append(section('条款 / 旅程 / 实现映射',`${labels(criterion.clauseIds,'clause')} / ${labels(criterion.journeyIds,'journey')} / ${labels(criterion.targetIds,'target')}；${criterion.uncertainty}`),button('删除此条件',()=>{scenario.criteria=scenario.criteria.filter(c=>c!==criterion);renderDraft();}));}
  group.append(button('添加验收条件',()=>{scenario.criteria.push(newCriterion());renderDraft();}),button('删除此场景',()=>{draft=draft.filter(s=>s!==scenario);renderDraft();}));
  const mapping=el('details');mapping.append(el('summary','高级：编辑映射（JSON）'));const json=field(mapping,'当前场景 JSON',el('textarea'));json.value=JSON.stringify(scenario,null,2);json.rows=10;mapping.append(button('应用此场景 JSON',()=>{try{const value=JSON.parse(json.value);if(value.id!==scenario.id||!Array.isArray(value.criteria))throw new Error('须保留场景 ID 和条件数组');draft[draft.indexOf(scenario)]=value;renderDraft();}catch(e){error.textContent=e.message;}}));group.append(mapping);
 }};
 const error=el('p',undefined,'conflict');error.setAttribute('role','alert');host.append(error);renderDraft();
 host.append(button('添加场景',()=>{draft.push({id:`scenario-${key()}`,title:'新场景',given:'填写前提',when:'填写用户动作',then:'填写可见结果',critical:'supporting',...emptyMapping(),criteria:[newCriterion()]});renderDraft();}));
 const author=field(host,'确认人',el('input'));author.value=confirmed?.author||'Owner';const round=field(host,'关联开发轮次',el('select'));const none=el('option','尚未开始开发（运行验证时必须绑定轮次）');none.value='';round.append(none);for(const r of state.rounds?.rounds||[]){if(r.goalHash!==goal?.hash)continue;const o=el('option',`${r.id} · ${r.purpose}`);o.value=r.id;round.append(o);}round.value=confirmed?.roundId||'';
 const send=async decision=>{try{const result=await submit('scenario-review',{expectedGeneration:generation,proposalId:baseline.id,decision,author:author.value,roundId:round.value||null,scenarios:draft});$('dialog').close();editing=false;if(!result.analysisError)notice('已保存本次场景核对；正在按新条件重新分析。');}catch(e){error.textContent=e.message;}};
 host.append(button('确认这一组场景与条件',()=>send('confirm'),'primary'),button('拒绝这组提议',()=>send('reject')));
 const history=el('details');history.append(el('summary','场景历史与旧目标确认'));for(const x of state.scenarioSets||[])history.append(section(`G${x.goalVersion} · ${x.status}`,`${x.id} · ${x.author} · ${x.createdAt} · ${x.goalHash===goal?.hash?'当前目标':'旧目标，已失效'}`));host.append(history);
}
function showVerification(coverage=null){
 const host=dialog('实际验证、覆盖与运行调用');let loop=state.closedLoop;editing=true;
 if(historicalRound||coverage?.status==='unavailable'){host.append(el('p','历史或过时图不使用当前目标的运行证据。请返回当前分析查看当前条件与回执。'));return;}
 if(coverage){const receiptIds=new Set(coverage.criteria.flatMap(c=>c.evidence.map(e=>e.receiptId)));loop={...loop,receipts:(loop?.receipts||[]).filter(r=>receiptIds.has(r.id)),runtimeCalls:(loop?.runtimeCalls||[]).filter(t=>receiptIds.has(t.receiptId)&&coverage.targetIds.includes(t.edgeId))};}
 host.append(el('p','本页面只导入登记证据根中的回执。检查由操作者在本机 CLI 显式选择运行；退出码或代理报告不代表验收条件通过。'));
 const names={passed:'条件通过','environment-blocked':'环境前提阻塞','missing-capability':'明确能力缺失','behavior-failed':'行为不符',unknown:'未知 / 缺少条件证据'};
 if(coverage)host.append(section('所选对象的运行覆盖',`${coverage.label}；实现 ${coverage.targetIds.join(', ')||'未映射'}；条款 ${coverage.clauseIds.join(', ')||'未映射'}；仅这些明确映射的条件，不证明相邻连接。`));
 for(const c of coverage?coverage.criteria:loop?.criteria||[]){const box=section(`${c.scenarioTitle} · ${c.text}`,`${names[c.status]||c.status}${c.recovered?' · 同检查复测已恢复，历史失败保留':''}${c.mixed?' · 独立检查结果冲突':''}；观察方法：${c.observable}；映射：${c.mapping}`);for(const e of c.evidence)box.append(section(`${e.receiptId} · ${e.roundId}`,`${e.current===false?'历史复测前结果':'当前执行结果'} · ${e.checkId||''} · ${e.at||''} · ${e.status}；${e.actual}；${e.evidence}`));for(const id of c.targetIds)box.append(button(`查看实现 ${id}`,()=>{ $('dialog').close();editing=false;select(view?.analysis.modules.some(m=>m.id===id)?'module':'edge',id);}));host.append(box);}
 if(loop?.uncoveredClauseIds?.length)host.append(section('尚未覆盖的核心条款',loop.uncoveredClauseIds));
 const runtime=el('details');runtime.append(el('summary','运行调用（独立于源码调用候选）'));if(!loop?.runtimeCalls?.length)runtime.append(el('p','没有实际调用 trace；不从 import、模块顺序或模型输出构造运行调用图。'));for(const t of loop?.runtimeCalls||[])runtime.append(section(`${t.from} → ${t.to}`,`检查 ${t.checkId} · exit ${t.exitCode} · 断言 ${(t.assertionStatuses||[]).join(', ')} · ${t.edgePassed?'对应条件通过':'仅观察到调用，不证明边通过'} · ${t.event} · trace ${t.traceId} · ${t.evidence} · ${t.receiptId} · ${t.roundId}`));host.append(runtime);
 for(const r of loop?.receipts||[]){const detail=el('details');detail.append(el('summary',`${r.id} · ${r.current?'当前绑定':'过时 / 来源变化'} · ${r.binding.roundId}`),section('绑定',`G${r.binding.goalVersion} · ${r.binding.sourceHash} · ${r.binding.confirmationId}`));for(const c of r.checks)detail.append(section(c.id,`${c.argv.join(' ')}；退出 ${c.exitCode}；${c.executionError||'执行记录已保留'}`),section('环境前提',c.preflight.map(p=>`${p.value}: ${p.passed?'可用':p.reason}`)),section('标准输出',c.stdout),section('标准错误',c.stderr));host.append(detail);}
 const form=el('fieldset');form.append(el('legend','导入 CLI 回执'));host.append(form);const root=field(form,'登记证据根序号',el('input'));root.type='number';root.min='0';root.value='0';const path=field(form,'回执相对路径',el('input')),sha=field(form,'文件 SHA256（CLI 输出）',el('input'));
 form.append(button('导入回执',async()=>{try{const result=await submit('verification-import',{record:{rootIndex:Number(root.value),path:path.value,sha256:sha.value}});showVerification();if(!result.analysisError)notice(result.duplicate?'回执已存在；没有重复安排分析。':'回执已保存；正在按新证据自动重分析主线建议。');}catch{}}));
}
