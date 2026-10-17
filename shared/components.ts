import type { LogicalComponent } from './types';

/** Observable GPIO outputs; a motor exposes its two H-bridge control signals. */
export function outputSignals(components: readonly LogicalComponent[]): string[] {
  return components.flatMap((component) => component.kind === 'motor'
    ? [`${component.id}_forward`, `${component.id}_reverse`]
    : component.kind === 'led' ? [component.id] : []);
}
