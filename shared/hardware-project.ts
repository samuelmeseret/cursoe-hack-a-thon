import type { DeviceProfile } from './hardware-types';

export type BindingKind = 'serial' | 'digital-input' | 'analog-input' | 'digital-output' | 'pwm-output';
export interface HardwareBinding {
  signalId: string;
  direction: 'input' | 'output';
  kind: BindingKind;
  pin?: string;
  component: string;
  notes?: string;
  activeLow?: boolean;
  /** Analog readings map 0..ADC maximum to this declared engineering range. */
  minimum?: number;
  maximum?: number;
}
export interface HardwareConfiguration {
  fqbn: string;
  bindings: HardwareBinding[];
  libraries: { name: string; version?: string }[];
  baudRate: number;
  serialTimeoutMs: number;
}
export interface HardwareEvidence {
  generated: boolean;
  compiled: boolean;
  simulationChecked: boolean;
  controllerParity: boolean;
  physicalTested: false;
  fingerprint: string;
  checkedAt: string;
  artifactHashes: Record<string, string>;
  parityChecks: number;
  statement: string;
}
export interface HardwareProjectState {
  projectId: string;
  revisionId: string;
  configuration?: HardwareConfiguration;
  profile?: DeviceProfile;
  status: 'UNCONFIGURED' | 'CONFIGURED' | 'BUILDING' | 'COMPILED' | 'FAILED' | 'STALE';
  issues: string[];
  evidence?: HardwareEvidence;
  log?: string;
  error?: string;
  updatedAt: string;
  upload?: { port: string; uploadedAt: string; log: string; statement: string };
}
