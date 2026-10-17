# Agent frontend

Vite + React + TypeScript. A single-screen Arduino agent workspace with live
playback of the existing synthetic fixture. The desktop shell follows the supplied
reference: warm stone surround, off-white surfaces, agent filter sidebar,
context sidebar, scrollable workspace, and an anchored goal composer.

## Run locally

Use Node.js 22.12+.

```sh
cd frontend
npm ci
npm run dev
```

From the repository root, `npm --prefix frontend run dev` also works.
`npm run build` checks TypeScript and produces the Vite production build.

## Interactions

Choose one of three sample-goal chips or type a goal; Run or Enter starts playback.
Shift+Enter adds a line. Input and Run are disabled until playback completes.
All goals currently replay the same recorded LED/button fixture; the composer
states this explicitly. This does not generate new firmware or run real hardware.

The original 12 events arrive at their recorded relative timestamps, over 23.6s.
Filters narrow the timeline without changing the run. Select a timeline event for
more details. Overview shows criteria and the final verdict; Decisions shows the
supervisor history. Sketch supports all arrived attempts, Shiki C++ highlighting,
and a line diff against the previous attempt. Test shows the independent scenario
and simulation evidence. Serial output arrives with the simulation event.

## Original project code

Application-specific code is in `src/components/agent/`, with the explicitly
requested brand component in `src/components/brand/`:

- `useRunPlayback.ts`: abortable playback hook and mock event-source adapter.
- `run-view.ts`: event-derived state, agent status, and readout text.
- `AgentWorkspace.tsx`: shell, goal selection, and composition.
- `AgentSidebar.tsx`, `RunContext.tsx`, `AgentTimeline.tsx`: domain views composed
  from installed Watermelon components and React Bits AnimatedList.
- `RunComposer.tsx`: controlled input, keyboard submission, and run state.
- `RunArtifacts.tsx`, `CodeReadout.tsx`, `highlight.ts`: attempt selection, Shiki,
  line comparison, test evidence, and serial readout.
- `workspace.css`: layout and restyling. Theme tokens remain in `src/index.css`.
- `../brand/Logo.tsx` and `LogoMotion.tsx`: the user-supplied SVG and its run-driven gear
  animation. The gear turns every 3.6 seconds, briefly reverses on a supervisor
  decision, and eases to a stop. The star stays fixed. Reduced motion keeps the
  logo static beside the existing running labels. `public/favicon.svg` is static.

The fixture and its event types in `src/mock/run.ts` are unchanged. To connect a
backend, replace `mockEventSource` with a `RunEventSource` that takes the goal and
feeds `onEvent` / `onActivity`, honors the AbortSignal, and resolves when finished.
The hook handles cleanup, prevents overlapping runs, and reports source failures.

## Component sources and design

See [REGISTRY_COMPONENTS.md](REGISTRY_COMPONENTS.md) for installed component names,
actual historical CLI commands, adaptations, and custom-view rationale.
Licenses are in [../THIRD_PARTY.md](../THIRD_PARTY.md), with notices shipped in public/.

IBM Plex Sans / Mono, soft corners, meaningful muted accents, no icons in agent
navigation, no gradients, no hover movement. Reduced motion is respected.
Target desktop widths are 1440–1920px; mobile/tablet layouts are intentionally out
of scope. No routes, accounts, search, settings, charts, or decorative assets.
