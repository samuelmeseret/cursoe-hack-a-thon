import type { TracePoint } from './types';

export type MotorState = 'forward' | 'reverse' | 'stopped' | 'braking' | 'unpowered';
export function motorState(signals: Record<string, TracePoint>, id: string): MotorState {
  const forward = signals[`${id}_forward`];
  const reverse = signals[`${id}_reverse`];
  if (forward?.mode !== 'output' || reverse?.mode !== 'output') return 'unpowered';
  if (forward.value === 1 && reverse.value === 1) return 'braking';
  if (forward.value === 1) return 'forward';
  if (reverse.value === 1) return 'reverse';
  return 'stopped';
}

/** Illustrative travel integrates measured motor drive time, never keyboard events. */
export class MotorMotion {
  private readonly signals: Record<string, TracePoint> = {};
  private atMs = 0;
  driveMs = 0;
  constructor(private readonly motorIds: string[]) {}

  get direction(): number {
    if (!this.motorIds.length) return 0;
    return this.motorIds.reduce((sum, id) => {
      const state = motorState(this.signals, id);
      return sum + (state === 'forward' ? 1 : state === 'reverse' ? -1 : 0);
    }, 0) / this.motorIds.length;
  }

  advance(trace: TracePoint[], atMs: number): void {
    const integrate = (until: number) => {
      if (until < this.atMs) throw new Error('Motor trace time moved backwards');
      this.driveMs += (until - this.atMs) * this.direction;
      this.atMs = until;
    };
    for (const point of trace) {
      integrate(point.atMs);
      this.signals[point.signal] = point;
    }
    integrate(atMs);
  }
}
