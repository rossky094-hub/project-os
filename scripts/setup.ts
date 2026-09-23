import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contained, safePath } from '../src/core/human-goal-workflow/source.js';
import { configSchema, safeId, text } from '../src/core/human-goal-workflow/types.js';

const packageRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const local = join(packageRoot, '.local');
const configPath = join(local, 'config.json');
const dataLink = join(local, 'data');

function usage(): never {
  throw new Error('用法: npm run setup -- --source PROJECT_DIR --scope RELATIVE_PATH [--scope RELATIVE_PATH ...] [--exclude RELATIVE_PATH ...] [--evidence EVIDENCE_DIR ...] [--data EXTERNAL_DATA_DIR] [--id PROJECT_ID] [--label NAME] [--revision REVISION] [--case-role self-case|positive-subject|negative-subject]');
}

function parse(args: string[]) {
  if (args.includes('--help')) {
    console.log('只登记明确指定的本地来源、范围和证据根；不读取源文件、不启动模型。\n' +
      'npm run setup -- --source PROJECT_DIR --scope RELATIVE_PATH [--scope ...] [--exclude ...] [--evidence EVIDENCE_DIR] [--data EXTERNAL_DATA_DIR]');
    process.exit(0);
  }
  const values = new Map<string, string[]>();
  const allowed = new Set(['source', 'scope', 'exclude', 'evidence', 'data', 'id', 'label', 'revision', 'case-role']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!args[i]?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--')) usage();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  for (const key of ['source', 'data', 'id', 'label', 'revision', 'case-role'])
    if ((values.get(key)?.length ?? 0) > 1) usage();
  if (values.get('source')?.length !== 1 || !values.get('scope')?.length) usage();
  return (key: string) => values.get(key) ?? [];
}

function existingDirectory(value: string, label: string): string {
  const path = realpathSync(resolve(value));
  if (!lstatSync(path).isDirectory()) throw new Error(`${label} 必须是已有目录: ${value}`);
  return path;
}

function relativeSelection(value: string, source: string, mustExist: boolean): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').includes('..'))
    throw new Error(`范围或排除路径须是来源根下的相对路径: ${value}`);
  const full = resolve(source, value);
  if (!contained(source, full)) throw new Error(`范围或排除路径越界: ${value}`);
  if (mustExist) safePath(source, value);
  else {
    let cursor = full;
    while (!existsSync(cursor)) cursor = dirname(cursor);
    if (!contained(source, realpathSync(cursor))) throw new Error(`排除路径经符号链接越界: ${value}`);
  }
  return relative(source, full) || '.';
}

function destination(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`数据目录无法解析: ${path}`);
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function main() {
  const arg = parse(process.argv.slice(2));
  const sourceRoot = existingDirectory(arg('source')[0], '来源');
  const scope = [...new Set(arg('scope').map(x => relativeSelection(x, sourceRoot, true)))];
  const exclude = [...new Set(arg('exclude').map(x => relativeSelection(x, sourceRoot, false)))];
  const evidenceRoots = [...new Set(arg('evidence').map(x => existingDirectory(x, '证据根')))];
  const dataTarget = destination(arg('data')[0] ?? join(dirname(packageRoot), `${basename(packageRoot)}-data`));
  const id = safeId.parse(arg('id')[0] ?? 'project');
  const caseRole = arg('case-role')[0] ?? 'positive-subject';
  if (!['self-case', 'positive-subject', 'negative-subject'].includes(caseRole)) usage();
  if (contained(packageRoot, dataTarget) || contained(dataTarget, packageRoot) ||
      contained(sourceRoot, dataTarget) || contained(dataTarget, sourceRoot))
    throw new Error('数据目录必须与 Project OS 包及已登记来源根分离');
  const registered = (path: string) => scope.some(part => contained(resolve(sourceRoot, part), path)) &&
    !exclude.some(part => contained(resolve(sourceRoot, part), path));
  if (contained(sourceRoot, dataLink) && (registered(dataLink) || registered(configPath)))
    throw new Error('已登记来源范围会读到 .local 数据或配置；缩小 --scope 或显式 --exclude .local');
  if (existsSync(configPath) || existsSync(dataLink)) throw new Error('.local/config.json 或 .local/data 已存在；保留原配置并人工检查');
  if (existsSync(local) && (!lstatSync(local).isDirectory() || lstatSync(local).isSymbolicLink()))
    throw new Error('.local 必须是包内普通目录');
  const project = {
    id, label: text.parse(arg('label')[0] ?? basename(sourceRoot)), sourceRoot, scope,
    revision: text.parse(arg('revision')[0] ?? 'working-tree-unpinned'),
    sourceKind: 'working-tree' as const, subjectId: id,
    caseRole: caseRole as 'self-case' | 'positive-subject' | 'negative-subject',
    exclude, evidenceRoots
  };
  const config = configSchema.parse({projects: [project], dataDir: dataLink, port: 0,
    analyzer: {command: 'codex', timeoutMs: null, maxAttempts: 2}, verificationChecks: {}});
  mkdirSync(dataTarget, {recursive: true});
  const actualData = realpathSync(dataTarget);
  if (actualData !== dataTarget || contained(packageRoot, actualData) || contained(actualData, packageRoot) ||
      contained(sourceRoot, actualData) || contained(actualData, sourceRoot))
    throw new Error('数据目录实际位置不满足隔离要求');
  mkdirSync(local, {recursive: true});
  symlinkSync(process.platform === 'win32' ? actualData : relative(local, actualData).split(sep).join('/'), dataLink,
    process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({config: configPath, dataDir: dataLink, actualDataDir: actualData,
    projectId: id, sourceRoot, scope, exclude, evidenceRoots}, null, 2));
}

main();
