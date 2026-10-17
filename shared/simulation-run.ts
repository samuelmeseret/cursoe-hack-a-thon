import type { SimulationCandidate, SimulationScenario, SimulationSpec, SimulationVerification } from './simulation-types';

export type SimulationRunStatus = 'QUEUED' | 'PLANNING' | 'DESIGNING_TESTS' | 'BUILDING' | 'CHECKING' | 'READY' | 'DRAFT' | 'FAILED' | 'CANCELLED' | 'STALE';
export interface SimulationRunEvent { sequence: number; at: string; phase: string; message: string }
export interface SimulationEvidence extends SimulationVerification { sourceHash: string; specHash: string; suiteHash: string; runtimeVersion: string; checkedAt: string }
export interface SimulationDraftEvidence { sourceHash: string; specHash: string; suiteHash: string; runtimeVersion: string; checkedAt: string }
export interface SimulationAttempt { candidate: SimulationCandidate; verification?: SimulationVerification; smoke?: { passed: boolean; error?: string }; error?: string }
export interface SimulationRun {
  id: string; parentId?: string; prompt: string; goal: string; model?: string;
  /** Stable across follow-up revisions; older saved simulations use their root run ID. */
  projectId?: string; revision?: number;
  status: SimulationRunStatus; createdAt: string; updatedAt: string; deadlineAt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  events: SimulationRunEvent[]; attempts: SimulationAttempt[];
  spec?: SimulationSpec; scenarios?: SimulationScenario[]; candidate?: SimulationCandidate;
  evidence?: SimulationEvidence; draftEvidence?: SimulationDraftEvidence; warning?: string; error?: string;
  errorCode?: string; errorFinishReason?: 'length' | 'content_filter';
}
export const simulationTerminal = (status: SimulationRunStatus) => ['READY', 'DRAFT', 'FAILED', 'CANCELLED', 'STALE'].includes(status);
