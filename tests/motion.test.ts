import { describe, expect, it } from 'vitest';
import { MotorMotion, motorState } from '../shared/motion';
import type { TracePoint } from '../shared/types';

const point = (signal: string, value: 0 | 1, atMs: number, mode: TracePoint['mode'] = 'output'): TracePoint => ({ signal, value, atMs, mode, cycle: atMs * 16000 });
describe('motor-driven vehicle display', () => {
  it('moves only for measured output drive, including reversals within a single trace packet', () => {
    const motion = new MotorMotion(['drive']);
    motion.advance([], 100);
    expect(motion.driveMs).toBe(0);
    motion.advance([
      point('drive_forward', 0, 100), point('drive_reverse', 0, 100),
      point('drive_forward', 1, 200), point('drive_forward', 0, 700),
      point('drive_reverse', 1, 700), point('drive_reverse', 0, 900),
    ], 1000);
    expect(motion.driveMs).toBe(300);
    expect(motion.direction).toBe(0);
    motion.advance([], 2000);
    expect(motion.driveMs).toBe(300);
  });

  it('does not move from floating inputs or simultaneous driver highs', () => {
    const motion = new MotorMotion(['drive']);
    motion.advance([point('drive_forward', 1, 0, 'input'), point('drive_reverse', 0, 0, 'input')], 100);
    expect(motion.driveMs).toBe(0);
    motion.advance([point('drive_forward', 1, 100), point('drive_reverse', 1, 100)], 200);
    expect(motion.driveMs).toBe(0);
    expect(motorState({ drive_forward: point('drive_forward', 1, 0), drive_reverse: point('drive_reverse', 1, 0) }, 'drive')).toBe('braking');
  });
});
