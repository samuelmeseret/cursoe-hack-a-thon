import type { Circuit } from '../shared/types.js';
const escape = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Diagram is generated from the validated templates, never supplied by an agent. */
export function circuitSvg(circuit: Circuit): string {
  const height = Math.max(320, circuit.components.length * 64 + 80);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}" role="img" aria-label="Arduino Uno wiring diagram"><rect width="800" height="${height}" fill="#151a1d"/><g font-family="monospace" font-size="14" fill="#d8dfdf"><rect x="32" y="40" width="220" height="${height - 80}" rx="8" fill="#243238" stroke="#597174"/><text x="56" y="75">ARDUINO UNO</text><text x="56" y="98" fill="#9cadb0">16 MHz · ATmega328P</text>${circuit.components.map((c, i) => {
    const y = 140 + i * 54;
    return `<text x="188" y="${y + 5}">D${c.pin}</text><path d="M240 ${y} H330" stroke="${c.kind === 'led' ? '#8de4be' : '#e9bb71'}" stroke-width="2"/><text x="340" y="${y - 12}">${escape(c.label)}</text>${c.kind === 'led' ? `<path d="M330 ${y} l8 -7 8 14 8 -14 8 14 8 -7 H405" fill="none" stroke="#8de4be" stroke-width="2"/><circle cx="420" cy="${y}" r="9" fill="none" stroke="#8de4be" stroke-width="2"/><text x="455" y="${y + 5}">220Ω → LED → GND</text>` : `<path d="M330 ${y} H390 M390 ${y} l30 -12 M420 ${y} H445" fill="none" stroke="#e9bb71" stroke-width="2"/><text x="455" y="${y + 5}">BUTTON → GND · INPUT_PULLUP</text>`}`;
  }).join('')}</g></svg>`;
}
