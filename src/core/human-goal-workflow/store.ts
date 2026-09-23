import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, safeId, schemaVersion, WorkflowError, type Session } from './types.js';
// Immutable objects plus an atomic, hash-bound pointer. Legacy Store/ledger stays untouched.
export class SessionStore {
  readonly root: string; private token = randomUUID(); private closed = false;
  constructor(root: string) {
    mkdirSync(resolve(root),{recursive:true}); this.root = realpathSync(root);
    const lock = join(this.root,'writer.lock');
    if (existsSync(lock)) {
      let owner: { pid: number; token: string };
      try { owner = JSON.parse(readFileSync(lock,'utf8')); if (!Number.isInteger(owner.pid) || !owner.token) throw new Error(); } catch { throw new WorkflowError('WRITE_CONFLICT','写锁损坏，保留原件并由操作者检查',409); }
      let alive = true; try { process.kill(owner.pid,0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new WorkflowError('WRITE_CONFLICT',`进程 ${owner.pid} 持有写租约`,409);
      renameSync(lock,join(this.root,`interrupted-lock-${owner.token}.json`));
    }
    try { writeFileSync(lock,JSON.stringify({pid:process.pid,token:this.token,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600}); } catch { throw new WorkflowError('WRITE_CONFLICT','写租约已被另一进程取得',409); }
    mkdirSync(join(this.root,'sessions'),{recursive:true});
  }
  private assertLease() {
    if (this.closed || JSON.parse(readFileSync(join(this.root,'writer.lock'),'utf8')).token !== this.token) throw new WorkflowError('WRITE_CONFLICT','当前实例不持有写租约',409);
  }
  private dir(id: string) { safeId.parse(id); return join(this.root,'sessions',id); }
  private atomic(path: string, value: unknown) {
    const temp = `${path}.${randomUUID()}.tmp`; const fd = openSync(temp,'wx',0o600);
    try { writeFileSync(fd,JSON.stringify(value,null,2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp,path); const dirFd = openSync(resolve(path,'..'),'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
  load(id: string): Session|null {
    const dir = this.dir(id), pointer = join(dir,'current.json'); if (!existsSync(pointer)) return null;
    try {
      const ref = JSON.parse(readFileSync(pointer,'utf8')); if (!/^[a-f0-9]{64}$/.test(ref.hash)) throw new Error('pointer hash');
      const state = JSON.parse(readFileSync(join(dir,`${ref.hash}.json`),'utf8')) as Session;
      if (hash(state) !== ref.hash || state.schemaVersion !== schemaVersion || state.projectId !== id || !Number.isInteger(state.generation) || !Array.isArray(state.attempts) || !Array.isArray(state.views) || !Array.isArray(state.goals) || !Array.isArray(state.feedback)) throw new Error('schema or hash');
      return state;
    } catch (e) { throw new WorkflowError('PERSISTENCE_FAILED',`状态损坏；保留原文件和不可变历史，请检查 ${dir}`,500,String(e)); }
  }
  save(state: Session) {
    this.assertLease(); const dir = this.dir(state.projectId); mkdirSync(dir,{recursive:true});
    const sha = hash(state), target = join(dir,`${sha}.json`);
    if (!existsSync(target)) { const fd = openSync(target,'wx',0o600); try { writeFileSync(fd,JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); } }
    this.atomic(join(dir,'current.json'),{schemaVersion,hash:sha,generation:state.generation});
  }
  interruptActive(id: string, endedAt = new Date().toISOString()) {
    const state = this.load(id); if (!state) return;
    let changed = false;
    for (const a of state.attempts) if (a.state === 'running' || a.state === 'queued') {
      const wasRunning = a.state === 'running';
      if (wasRunning) {
        if (a.totalBudgetMs === null) {
          // Crash time is unknown. Include all wall time to reopening as an upper
          // bound, plus prior attempts; never label it measured provider usage.
          const elapsed = Date.parse(endedAt) - Date.parse(a.startedAt ?? a.createdAt);
          if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(a.usedMs) || a.usedMs < 0)
            throw new WorkflowError('PERSISTENCE_FAILED','中断耗时无法确定，保留原件并检查时间记录',500);
          a.usedMs += elapsed;
          a.error = '进程中断：无时间上限；耗时按启动（旧记录按创建）至重开时间保守计入，包含可能的停机时间，非实测模型用量';
        } else {
          a.usedMs = Math.max(a.usedMs,a.totalBudgetMs);
          a.error = '进程中断：未确认的执行消耗按剩余预算保守计入';
        }
        a.elapsedAccounting = 'conservative-upper-bound';
      } else a.error = '进程中断：排队任务尚未启动';
      a.state = 'interrupted'; a.endedAt = endedAt; changed = true;
    }
    if (changed) this.save(state);
  }
  list(): string[] { return readdirSync(join(this.root,'sessions')).filter(id=>safeId.safeParse(id).success); }
  attemptDir(projectId: string, attemptId: string): string { safeId.parse(attemptId); const dir = join(this.dir(projectId),'attempts',attemptId); mkdirSync(dir,{recursive:true}); return dir; }
  close() { if (this.closed) return; this.assertLease(); unlinkSync(join(this.root,'writer.lock')); this.closed = true; }
}
