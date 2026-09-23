import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-os-setup-'));
  roots.push(root);
  const pkg = join(root, 'package');
  const source = join(root, 'subject');
  const evidence = join(root, 'evidence');
  for (const dir of [pkg, source, evidence, join(source, 'checks')]) mkdirSync(dir, { recursive: true });
  for (const path of ['scripts/setup.ts', 'src/core/human-goal-workflow/source.ts', 'src/core/human-goal-workflow/types.ts']) {
    const target = join(pkg, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(path), target);
  }
  symlinkSync(realpathSync(resolve('node_modules')), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(source, 'main.mjs'), 'export const answer = () => 42;\n');
  writeFileSync(join(source, 'checks', 'check.mjs'), 'export {};\n');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/setup.ts', ...args], {
    cwd: pkg, encoding: 'utf8', timeout: 15000
  });
  return { root, pkg, source, evidence, run };
}

describe('standalone setup', () => {
  it('records only explicit scope and evidence and links data outside the package and source', () => {
    const f = fixture();
    const result = f.run('--source', f.source, '--scope', 'main.mjs', '--scope', 'checks',
      '--exclude', 'checks/private', '--evidence', f.evidence, '--id', 'demo');
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(f.pkg, '.local', 'config.json'), 'utf8'));
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]).toMatchObject({
      id: 'demo', sourceRoot: realpathSync(f.source), scope: ['main.mjs', 'checks'],
      exclude: ['checks/private'], evidenceRoots: [realpathSync(f.evidence)]
    });
    expect(config.analyzer).toEqual({command: 'codex', timeoutMs: null, maxAttempts: 2});
    expect(config.dataDir).toBe(join(realpathSync(f.pkg), '.local', 'data'));
    expect(lstatSync(config.dataDir).isSymbolicLink()).toBe(true);
    expect(realpathSync(config.dataDir)).toBe(join(realpathSync(f.root), 'package-data'));
    const original = readFileSync(join(f.pkg, '.local', 'config.json'));
    const repeated = f.run('--source', f.source, '--scope', 'main.mjs', '--evidence', f.evidence);
    expect(repeated.status).not.toBe(0);
    expect(readFileSync(join(f.pkg, '.local', 'config.json'))).toEqual(original);
  });

  it('refuses data inside the source and a scope that would read its own local state', () => {
    const f = fixture();
    const nested = f.run('--source', f.source, '--scope', 'main.mjs', '--data', join(f.source, 'state'));
    expect(nested.status).not.toBe(0);
    expect(nested.stderr).toContain('数据目录必须');
    const self = f.run('--source', f.pkg, '--scope', '.');
    expect(self.status).not.toBe(0);
    expect(self.stderr).toContain('已登记来源范围会读到 .local');
    expect(existsSync(join(f.pkg, '.local', 'config.json'))).toBe(false);
  });
});
