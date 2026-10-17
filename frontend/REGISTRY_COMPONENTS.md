# Registry component installation record

Installed on 2026-10-17 from `frontend/`. All nine items succeeded with the shadcn
CLI. The first sandboxed Card 9 command was stopped after producing no output;
its network-enabled retry succeeded. No install was replaced with custom UI.
React Bits installs created `src/components/AnimatedList.tsx` and
`src/components/CountUp.tsx`; those installed paths are used directly.

| UI part | Library | Registry item | Install command run | File path |
| --- | --- | --- | --- | --- |
| Agent timeline list | React Bits | `AnimatedList-TS-TW` | `npx shadcn@latest add @react-bits/AnimatedList-TS-TW --yes --overwrite` | [src/components/AnimatedList.tsx](src/components/AnimatedList.tsx) |
| Panel containers and event rows | Watermelon | `card-9` | `npx shadcn@latest add https://registry.watermelon.sh/r/card-9.json --yes --overwrite` | [src/components/watermelon/card-9.tsx](src/components/watermelon/card-9.tsx) |
| Sketch / Test and context tabs | Watermelon | `card-10` | `npx shadcn@latest add https://registry.watermelon.sh/r/card-10.json --yes --overwrite` | [src/components/watermelon/card-10.tsx](src/components/watermelon/card-10.tsx) |
| Status indicators | Watermelon | `badge-12` | `npx shadcn@latest add https://registry.watermelon.sh/r/badge-12.json --yes --overwrite` | [src/components/watermelon/badge-12.tsx](src/components/watermelon/badge-12.tsx) |
| Attempt counter | React Bits | `CountUp-TS-TW` | `npx shadcn@latest add @react-bits/CountUp-TS-TW --yes --overwrite` | [src/components/CountUp.tsx](src/components/CountUp.tsx) |
| Supervisor decision | Watermelon | `alert-12` | `npx shadcn@latest add https://registry.watermelon.sh/r/alert-12.json --yes --overwrite` | [src/components/watermelon/alert-12.tsx](src/components/watermelon/alert-12.tsx) |
| Header title and metadata labels | Watermelon | `badge-1` | `npx shadcn@latest add https://registry.watermelon.sh/r/badge-1.json --yes --overwrite` | [src/components/watermelon/badge-1.tsx](src/components/watermelon/badge-1.tsx) |
| Serial readout and goal input | Watermelon | `textarea-3` | `npx shadcn@latest add https://registry.watermelon.sh/r/textarea-3.json --yes --overwrite` | [src/components/watermelon/textarea-3.tsx](src/components/watermelon/textarea-3.tsx) |
| Run / filters / chips / attempt controls | Watermelon | `button-1` | `npx shadcn@latest add https://registry.watermelon.sh/r/button-1.json --yes --overwrite` | [src/components/watermelon/button-1.tsx](src/components/watermelon/button-1.tsx) |

## Current reference redesign

The nine successful installs above are reused; no new registry component was
installed in this pass. Watermelon MCP searches for code/diff and empty-state
components did not find a suitable domain viewer. Existing Card 9, Card 10,
Button 1, badges, Alert 12, and Textarea 3 fit the other needs.

- Card 9 supplies context sections, title surface, criteria, empty introduction,
  timeline event rows, and pending states.
- Card 10 supplies Overview / Decisions and Sketch / Test tabs. Its paragraph
  content slot is now a div for valid rich-panel markup (code, sections, controls).
- Button 1 exposes standard button props and ReactNode content for working agent
  filters, goal chips, attempt controls, diff toggle, and the Run action.
- Alert 12 is text-only; its previous icon was removed. Decision reason and
  instructions are data slots. The amber border pulses once when mounted.
- AnimatedList retains its event entrance and keyboard/selection engine, uses
  light theme with no gradients/frame, and composes Card 9 / Alert 12. Selecting
  an event reveals details. CountUp animates attempt changes.
- Textarea 3 is controlled for the composer and read-only for serial output.
- Soft radii, warm off-white surfaces, muted colors, 160ms color transitions, IBM
  Plex fonts, no gradients/shadows/hover movement replace the previous dark style.

## Original code / custom reasons

Original frontend views stay in src/components/agent/. The explicitly requested
user-supplied brand mark is in src/components/brand/.

| UI part | Implementation | Reason |
| --- | --- | --- |
| Shell, sidebars, composer layout | AgentWorkspace, AgentSidebar, RunContext, RunComposer | Application layout and data wiring composed from the installed registry controls. |
| Run timeline and criteria | AgentTimeline, RunContext | Original event semantics composed from AnimatedList, Card 9, badges, and Alert 12. |
| Sketch / attempt diff | CodeReadout, RunArtifacts, highlight | Custom domain view: no suitable registry code/diff viewer found. Shiki renders C++ tokens; jsdiff computes line changes. |
| Playback and panel states | useRunPlayback, run-view | Original event-source, timing, cancellation, filters, and derived-state logic. |
| Project logo and loading indicator | brand/Logo.tsx, agent/LogoMotion.tsx; public/favicon.svg | User explicitly requested conversion of their supplied SVG. All three original paths are preserved; existing Motion drives only the gear group. No registry install or new dependency. |

Ran `npm install shiki diff` successfully in this pass. Shiki 4.5.0 is MIT;
jsdiff (diff) 9.0.0 is BSD-3-Clause. No custom fallback for a failed installation.
The mock data shape and fixture remain unchanged. Run replays the fixture for any
input and explicitly labels this as sample playback, not live generation.

## Verification scope

Production build and desktop browser interaction checks only. No tests added or
run. No mobile/tablet work. npm still reports seven high-severity advisories in
the shadcn CLI dependency chain; no forced dependency upgrades were attempted.
No commits or pushes were made.
