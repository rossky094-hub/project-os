import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODEX_INPUT_MAX_CHARS, makePrompt, projectInputTransport, reconstructInputTransport, type InputTransport } from '../../src/core/human-goal-workflow/analyzer.js';
import type { AnalysisInput } from '../../src/core/human-goal-workflow/types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const actualPreflight = process.env.PROJECT_OS_ANALYSIS_INPUT_PREFLIGHT ?? 'tests/fixtures/optional-analysis-input-transport-preflight.json';

function fixture(): AnalysisInput {
  const coverage = Array.from({length: 15}, (_, i) => `registered/path/${i}/${'long-name-'.repeat(6)}.ts`);
  const inventory = Array.from({length: 20}, (_, i) => ({path: coverage[i % coverage.length], sha256: sha(`file-${i}`), bytes: i}));
  return {
    schemaVersion: 'fixture', project: {} as AnalysisInput['project'],
    source: {files: [{path: 'source.ts', excerpt: `LITERAL SOURCE START\n${'x'.repeat(850_000)}`}] } as AnalysisInput['source'],
    goal: {originalText: '原始人的目标保持字面可读'} as AnalysisInput['goal'],
    expectations: [], feedback: [], observations: [], previous: null, previousSourceHash: null,
    generation: 1, inputHash: sha('fixture'), analyzerRevision: 'fixture', configHash: sha('config'),
    plan: {reason: '完整检查', targetIds: [], sourcePaths: [], reuse: [], limitations: []},
    rounds: {
      snapshots: Array.from({length: 60}, (_, i) => ({id: `snapshot-${i}`, sourceHash: sha(`source-${i}`), inventory, coverage,
        importedAt: `2026-09-23T00:00:${String(i % 60).padStart(2, '0')}.000Z`, partial: false})),
      events: Array.from({length: 800}, (_, i) => ({key: `codex-${sha(`key-${i}`).slice(0, 40)}`,
        projectId: 'project', registrationId: `registration-${i % 10}`, roundId: `round-${i % 10}`,
        attemptId: `attempt-${i % 10}`, producerId: `producer-${i % 10}`, sequence: i + 1,
        kind: 'checkpoint', rawHash: sha(`raw-${i}`), description: 'activity-observed',
        observedAt: i === 10 ? '2026-09-23T00:00:00.123456Z' : new Date(Date.UTC(2026, 8, 23) + i * 1000).toISOString(),
        sourceSnapshotId: null, dependsOn: []})),
      future: {literal: 'unknown field survives'},
    },
  } as AnalysisInput;
}

describe('current analysis metadata transport', () => {
  it('reconstructs full history, order and unknown fields while keeping source and goal literal', () => {
    const input = fixture(), before = JSON.stringify(input), projected = projectInputTransport(input);
    expect(projected.schemaVersion).toBe('project-os.analysis-input-transport.v3');
    expect(projected.metadataEncoding?.eventTime).toBe(true);
    expect(projected.metadataEncoding?.eventKeyPrefix).toBe('codex-');
    expect(projected.metadataEncoding?.strings.length).toBeGreaterThan(0);
    expect(projected.metadataEncoding?.fieldSets.length).toBeGreaterThan(0);
    expect(projected.input.source.files[0].excerpt).toBe(input.source.files[0].excerpt);
    expect(projected.input.goal?.originalText).toBe(input.goal?.originalText);
    expect(JSON.stringify(reconstructInputTransport(JSON.parse(JSON.stringify(projected))))).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    const prompt = makePrompt(input);
    expect(prompt.length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS);
    expect(prompt).toContain('LITERAL SOURCE START');
    expect(prompt).toContain(input.goal!.originalText);
  });

  it('rejects bad metadata references and preserves literal marker collisions', () => {
    const input = fixture(), projected = projectInputTransport(input);
    const missing = structuredClone(projected);
    (missing.input.rounds as any).future.literal = '§999999';
    expect(() => reconstructInputTransport(missing)).toThrow('缺少 metadata string ref');
    const duplicate = structuredClone(projected);
    duplicate.metadataEncoding!.strings.push(duplicate.metadataEncoding!.strings[0]);
    expect(() => reconstructInputTransport(duplicate)).toThrow('无效 metadata string table');
    const badShape = structuredClone(projected);
    (badShape.input.rounds as any).snapshots[0][1] = 999999;
    expect(() => reconstructInputTransport(badShape)).toThrow('无效 metadata object row');
    const badTime = structuredClone(projected);
    const row = (badTime.input.rounds as any).eventRows[0], timeColumn = badTime.eventEncoding!.fieldSets[row[0]].indexOf('observedAt');
    row[1][timeColumn] = Number.MAX_SAFE_INTEGER + 1;
    expect(() => reconstructInputTransport(badTime)).toThrow('无效 event time ref');
    const tampered = structuredClone(projected);
    tampered.metadataEncoding!.strings[0] += 'tampered';
    expect(() => reconstructInputTransport(tampered)).toThrow('hash 不匹配');
    const literal = fixture(); (literal.rounds as any).future.literal = '§1';
    expect(projectInputTransport(literal).schemaVersion).toBe('project-os.analysis-input-transport.v2');
    expect(JSON.stringify(reconstructInputTransport(projectInputTransport(literal)))).toBe(JSON.stringify(literal));
  });

  it.skipIf(!existsSync(actualPreflight))('roundtrips the frozen current input and fits without source abbreviation', () => {
    const prior = JSON.parse(readFileSync(actualPreflight, 'utf8')) as InputTransport;
    const input = reconstructInputTransport(prior), before = JSON.stringify(input);
    const projected = projectInputTransport(input), restored = reconstructInputTransport(projected);
    expect(projected.schemaVersion).toBe('project-os.analysis-input-transport.v3');
    expect(projected.originalInputSha256).toBe(prior.originalInputSha256);
    expect(JSON.stringify(restored)).toBe(before);
    expect(projected.input.source.files.map(f => f.excerpt)).toEqual(input.source.files.map(f => f.excerpt));
    expect(projected.input.goal).toEqual(input.goal);
    expect(makePrompt(input).length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS);
  });
});
