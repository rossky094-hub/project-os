import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RoundData, RoundAnalysisState } from './rounds.js';
import type { AgentActivityData } from './agent-activity.js';
import type { MainlineAnnotationData } from './mainline-progress.js';
export const schemaVersion = 'project-os.human-goal.v1';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => digest(canonical(value));
export const safeId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/);
export const text = z.string().min(1).max(12000);
export const importance = z.enum(['hard-constraint','core','supporting','optional']);
export const clauseSchema = z.object({ id: safeId, text, importance, constraints: z.array(text).max(30).default([]), examples: z.array(text).max(30).default([]) }).strict();
export type Clause = z.infer<typeof clauseSchema>;
export const projectSchema = z.object({ id: safeId, label: text, sourceRoot: text, sourceReadPolicy: z.object({maxBytes:z.number().int().min(1).max(1048576)}).strict().optional(), scope: z.array(text).min(1).max(200), revision: text, sourceKind: z.enum(['snapshot','working-tree']), subjectId: safeId, caseRole: z.enum(['self-case','positive-subject','negative-subject']), snapshotManifest: text.optional(), exclude: z.array(text).max(100).optional(), evidenceRoots: z.array(text).default([]) }).strict();
export type Project = Omit<z.infer<typeof projectSchema>, 'evidenceRoots'> & { evidenceRoots?: string[] };
// Reading allowance affects analysis material, not the registered project identity.
export function projectRegistryHash(project:Project):string {const {sourceReadPolicy,...identity}=project;return hash(identity);}
export const eventReadPolicySchema = z.object({maxRecordBytes:z.number().int().min(256000).max(1048576).default(256000)}).strict();
export const registeredCheckSchema = z.object({id:safeId,label:text,argv:z.array(text).min(1).max(100),prerequisites:z.array(z.object({kind:z.enum(['path','env']),value:text}).strict()).max(50).default([]),bindings:z.array(z.object({assertionId:safeId,scenarioId:safeId,criterionId:safeId}).strict()).min(1).max(200)}).strict();
export const configSchema = z.object({ verificationChecks:z.record(z.array(registeredCheckSchema).max(100)).default({}), projects: z.array(projectSchema).min(1).max(50), eventReadPolicy:eventReadPolicySchema.default({}), roundAnalysis: z.object({enabled:z.boolean().default(false),historical:z.boolean().default(false)}).strict().default({}), roundPolicy: z.object({window:z.number().int().min(2).max(30),noProofThreshold:z.number().int().min(2).max(30),addedBytesThreshold:z.number().int().nonnegative()}).strict().optional(), dataDir: text, port: z.number().int().min(0).max(65535).default(0), analyzer: z.object({ command: text.default('codex'), timeoutMs: z.number().int().min(1000).max(600000).nullable().default(240000), maxAttempts: z.number().int().min(1).max(3).default(2) }).strict().default({}) }).strict();
export type Config = z.infer<typeof configSchema>;
export interface SourceRef { path: string; sha256: string; start: number; end: number }
export interface SourceFile { path: string; sha256: string; bytes: number; lines: number; excerpt: string; suppliedLines: number; ranges: { start: number; end: number }[]; symbols: string[]; truncated: boolean }
export interface SourceSnapshot { readGaps?: { path: string; start: number; end: number; reason: string }[]; schemaVersion: string; id: string; hash: string; projectId: string; subjectId: string; root: string; scope: string[]; declaredRevision: string; sourceKind: Project['sourceKind']; caseRole: Project['caseRole']; observedAt: string; runtime: string; files: SourceFile[]; inventory: { path: string; sha256: string; bytes: number }[]; omitted: { path: string; reason: string }[]; partial: boolean; totalBytes: number; suppliedBytes: number; relationships: { from: string; to: string; kind: string; line: number }[] }
const ref = z.object({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), start: z.number().int().positive(), end: z.number().int().positive() }).strict();
const refs = z.array(ref).max(100);
const ids = z.array(safeId).max(200);
export const diagnosisSchema = z.object({
 scope:z.enum(['product','workflow','local']),certainty:z.enum(['supported-hypothesis','unknown']),scopeReason:text,
 conclusion:text,clauseIds:ids,journeys:z.array(z.object({id:safeId,title:text,clauseIds:ids,targetIds:ids,expected:text,actual:text,uncertainty:text,refs}).strict()).max(50),
 evidence:refs,counterEvidence:refs,alternatives:z.array(z.object({explanation:text,refs,discriminatingObservation:text}).strict()).max(20),
 recommendation:z.object({action:text,reason:text,kind:z.enum(['investigate','repair-local','revise-approach','add-evidence']),clauseIds:ids,journeyIds:ids,targetIds:ids,
 options:z.array(z.object({disposition:z.enum(['reuse','adapt','propose','defer']),subject:text,reason:text}).strict()).max(30),verificationJourney:text}).strict(),
 taskAssessment:z.object({relevance:z.enum(['supports-goal','needs-review','unknown']),reason:text,remaining:text}).strict()
}).strict();
// Workflow steps describe a user result; implementation edges never imply step order.
export const relationshipKind = z.enum(['call','data-flow','dependency','event','control-flow','unclassified']);
export const evidenceState = z.enum(['source-supported','unknown','proposed']);
export const implementationEdgeSchema = z.object({ id: safeId, from: safeId, to: safeId, label: text, expected: text, actual: text, refs, kind: relationshipKind.optional(), certainty: evidenceState.optional() }).strict();
const workflowStepSchema = z.object({id:safeId,title:text,purpose:text,actor:text,responsibility:text,inputs:z.array(text).max(30),outputs:z.array(text).max(30),actual:text,state:evidenceState,targetIds:ids,clauseIds:ids,refs,uncertainty:text}).strict();
const workflowLinkSchema = z.object({id:safeId,from:safeId,to:safeId,kind:z.enum(['sequence','branch','feedback']),condition:text,meaning:text,state:evidenceState,refs,targetIds:ids.optional(),clauseIds:ids.optional()}).strict();
const workflowFlowSchema = z.object({steps:z.array(workflowStepSchema).max(100),links:z.array(workflowLinkSchema).max(200)}).strict();
export const workflowSchema = z.object({status:z.enum(['established','unknown']),summary:text,coverage:z.enum(['registered-scope','partial']),unknowns:z.array(text).max(200),journeys:z.array(z.object({id:safeId,title:text,purpose:text,clauseIds:ids,observed:workflowFlowSchema,desired:workflowFlowSchema}).strict()).max(30)}).strict();
export const scenarioSchema = z.object({id:safeId,title:text,critical:z.enum(['critical','supporting']),given:text,when:text,then:text,clauseIds:ids,journeyIds:ids,targetIds:ids,mapping:z.enum(['mapped','unknown']),uncertainty:text,criteria:z.array(z.object({id:safeId,text,observable:text,clauseIds:ids,journeyIds:ids,targetIds:ids,mapping:z.enum(['mapped','unknown']),uncertainty:text}).strict()).min(1).max(50)}).strict();
export const scenarioListSchema=z.array(scenarioSchema).max(50);
export type Scenario=z.infer<typeof scenarioSchema>;
export interface ScenarioSet {id:string;goalHash:string;goalVersion:number;sourceHash:string;analysisAttemptId:string;scenarios:Scenario[];status:'proposed'|'confirmed'|'rejected';proposalId?:string;author:string;createdAt:string;roundId:string|null;hash:string}
export const analysisSchema = z.object({
  scenarios:scenarioListSchema.optional(), workflow: workflowSchema.optional(), diagnosis: diagnosisSchema.optional(), purpose: text, purposeRefs: refs, limitations: z.array(text).max(100),
  modules: z.array(z.object({ id: safeId, title: text, kind: z.enum(['discovered','proposed']), responsibility: text, inputs: z.array(text), outputs: z.array(text), refs, supersedes: ids }).strict()).min(1).max(150),
  edges: z.array(implementationEdgeSchema).max(300),
  alignments: z.array(z.object({ id: safeId, clauseIds: ids, targetIds: ids, status: z.enum(['implemented-unverified','unknown','downstream-blocked']), rationale: text, refs }).strict()).max(400),
  gaps: z.array(z.object({ id: safeId, clauseIds: ids, targetIds: ids, kind: z.enum(['missing-function','wrong-behavior','missing-connection','quality-constraint','missing-evidence','missing-environment','misunderstood-goal']), expected: text, actual: text, certainty: z.enum(['supported-hypothesis','unknown']), refs, counterEvidence: refs, causeHypotheses: z.array(text), uncertainty: text, nextObservation: text, action: text, actionKind: z.enum(['investigate','add-evidence','repair-code','clarify-goal']), prerequisites: z.array(text), expectedOutcome: text, verificationPlan: text, unblocksClauseIds: ids, effort: z.enum(['small','medium','large','unknown']), risk: z.enum(['low','medium','high','unknown']) }).strict()).max(300),
  conflicts: z.array(z.object({ targetId: safeId, clauseIds: ids, parentText: text, moduleText: text, reason: text }).strict()).max(100),
  changes: z.array(z.object({ gapId: safeId, disposition: z.enum(['retracted','stale']), reason: text, refs }).strict()).max(300),
  coverageNotes: text, feedbackResponse: text
}).strict();
export type Analysis = z.infer<typeof analysisSchema>;
export interface Goal { id: string; version: number; originalText: string; clauses: Clause[]; author: string; provenance: string; createdAt: string; hash: string }
export interface Expectation { targetId: string; responsibility: string; inputs: string[]; outputs: string[]; examples: string[]; clauseIds: string[]; disposition: 'required'|'optional'|'unnecessary'|'proposed-missing'; replaces: string[] }
export interface GoalReview { clauseId:string; goalHash:string; sourceHash:string; analysisAttemptId:string; decision:'matches'|'mismatch'|'unknown'; nextObservation:string }
export interface Feedback { id: string; originalText: string; kind: 'interpretation-correction'|'desired-change'|'evidence-contribution'; targetIds: string[]; author: string; provenance: string; supersedes?: string; createdAt: string; goalVersion: number | null; classification: 'confirmed'; expectation?: Expectation; goalReview?:GoalReview }
export interface Observation { roundIds?: string[]; scopeSummary?: string|null; limitations?: string[]|null; id: string; sourceHash: string; goalHash: string; producer: string; targetIds: string[]; clauseIds: string[]; rawRecord: string; rawHash: string; result: 'passed'|'failed'|'unknown'; qualified: boolean; qualificationReason: string; invocation: unknown; createdAt: string }
export interface AnalysisInput { verificationChecks?:Config['verificationChecks'][string]; scenarioSet?:ScenarioSet|null; closedLoop?:unknown; snapshotCountAtRead?: number; materialHash?: string; rounds?: unknown; schemaVersion: string; project: Project; source: SourceSnapshot; goal: Goal|null; expectations: Expectation[]; feedback: Feedback[]; observations: Observation[]; previous: Analysis|null; previousSourceHash: string|null; generation: number; inputHash: string; analyzerRevision: string; configHash: string; plan: { reason: string; targetIds: string[]; sourcePaths: string[]; reuse: string[]; limitations: string[] } }
export interface Attempt { id: string; parentAttemptId: string|null; state: 'queued'|'running'|'completed'|'partial'|'failed'|'interrupted'; input: AnalysisInput; createdAt: string; endedAt?: string; usedMs: number; totalBudgetMs: number|null; startedAt?: string; elapsedAccounting?: 'measured'|'conservative-upper-bound'; attemptNumber: number; promoted: boolean; error?: string; result?: Analysis; rawDir: string; recoveryBasis?: string }
export type GapView = Analysis['gaps'][number] & { lifecycle: 'open'|'scope-changed'|'retracted'|'stale'|'resolved'; rankReason: string; rank: number; certainty: 'supported-hypothesis'|'unknown'; closureReason?: string };
export interface View { generation: number; attemptId: string; source: SourceSnapshot; goal: Goal|null; analysis: Analysis; gaps: GapView[]; createdAt: string; status: 'completed'|'partial'; changes: { goal: string; interpretation: string; source: string; ranking: string; evidence: string } }
export interface AnalysisContinuation { fromAttemptId:string; toAttemptId:string; sourceHash:string; goalHash:string; fromAnalysisHash:string; toAnalysisHash:string; createdAt:string }
export interface Session { analysisContinuations?:AnalysisContinuation[]; mainlineAnnotations?:MainlineAnnotationData; agentActivity?:AgentActivityData; scenarioSets?:ScenarioSet[]; verificationReceipts?:import('./verification.js').VerificationReceipt[]; expectationHistory?:{goalHash:string|null;expectations:Expectation[];createdAt:string}[]; roundAnalysis?: RoundAnalysisState; rounds?: RoundData; schemaVersion: string; projectId: string; registryHash: string; generation: number; goals: Goal[]; feedback: Feedback[]; expectations: Expectation[]; observations: Observation[]; attempts: Attempt[]; views: View[]; currentView: number|null; conflicts: { request: unknown; reason: string; createdAt: string }[]; idempotency: Record<string,{ payloadHash: string; result: unknown }>; actions: { id: string; gapId: string; generation: number; createdAt: string }[] }
export class WorkflowError extends Error { constructor(public code: string, message: string, public status = 400, public details: unknown = null) { super(message); } }
export interface Analyzer { revision: string; analyze(input: AnalysisInput, directory: string, signal: AbortSignal, timeoutMs: number|null): Promise<unknown> }
