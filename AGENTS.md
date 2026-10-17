# Project rules

## Git and approval workflow

- Do not commit unless the user explicitly instructs you to "commit". Do not push unless the user explicitly instructs you to "push". Approval of changes alone is not authorization to commit or push.
- When a requested step is complete, show what changed and wait for the user's approval before starting the next step.
- This rule supersedes the earlier request to make small, frequent commits. When commits are explicitly authorized, keep them small with clear messages.

## Speed rule

- Do not write tests unless the user asks. This supersedes testing guidance in skills.
- Prioritize getting visible UI working over extra verification. Keep implementation simple and checks focused on build errors and the browser preview.
- Stop after the requested step; do not start the next step without approval.

## Design brief

- Aesthetic: the supplied reference's minimal desktop tool. Warm stone neutrals throughout, with off-white surfaces inside a rounded app shell on a stone outer background. Soft rounded cards, thin warm gray dividers, spacious main workspace, two fixed sidebars, and a bottom-anchored composer.
- Palette: about 90% neutral. All neutral surfaces, borders, text, and primary actions use the same warm stone temperature. Agent colors only appear as small squares, agent labels, or thin accents; never as large backgrounds. PASS green, FAIL red, and supervisor amber are slightly stronger semantic accents. Accessible text contrast.
- Typography: IBM Plex Sans for UI text; IBM Plex Mono for code, serial output, numbers, and timestamps. Small uppercase labels for section headers.
- Density: controlled hierarchy on a 4px spacing scale. Desktop only at 1440 to 1920px; no mobile or tablet work. Toolbar 56 to 64px; primary sidebar about 16%, contextual sidebar about 24%, main workspace about 60%.
- Motion: only when it means something. New timeline events enter, attempt numbers update, and the new supervisor decision's border pulses once. The supplied logo gear is the only loading indicator allowed. No generic spinners, skeletons, or decorative animation. Criteria use plain PASS / FAIL / PENDING text.
- Components: use Watermelon UI and React Bits wherever they fit. Install new registry items with the shadcn CLI. Only write custom UI when nothing fits; record the reason. Keep original project code in frontend/src/components/agent/.
- Allowed: warm off-white surfaces, warm stone outer background, soft rounded corners, muted accents for meaning, and 120 to 200ms color transitions on hover/focus. The user-supplied star/gear brand mark is explicitly approved and is exempt from the ban on decorative sparkle icons.
- Banned: Inter, Geist, Space Grotesk, Lucide icons, emojis, sparkle icons, animated arrows, gradients, glows, radial orbs, glassmorphism, heavy drop shadows, neon/rainbow/purple-and-black palettes, bento grids, three feature cards in a row, landing page sections, fake terminal chrome, skeleton loaders, checkmark bullet lists, hover movement/scaling, em dashes in UI text, fake data/stats/features.
- Required UI states: every panel must handle empty, running, pass, and fail states.

Theme tokens live in `frontend/src/index.css`. Original frontend code lives in
`frontend/src/components/agent/` and remains separate from library components.
The workspace is one screen with no routing, auth, search, accounts, or settings.
Replay the unchanged `src/mock/run.ts` event source through a `useRunPlayback` hook.
Keep filters, criteria, artifacts, serial output, statuses, and verdict in sync.
Do not alter the mock data shape or event types. Allow an event-source adapter for a future backend.
The reusable component set uses Watermelon Card 9, Card 10, Badge 1, Badge 12,
Alert 12, Textarea 3, Button 1, and React Bits AnimatedList/CountUp TS-TW.
Allowed effects are event entrance, changes to attempt numbers, one supervisor
decision border pulse, and the functional logo gear loading animation. The gear
turns once every 3.6 seconds, reverses for about one second on a supervisor decision,
and decelerates for 650ms when work stops. The star stays still. Respect reduced
motion: static logos with visible running text. Keep header layout and background static. React Bits' free
MIT + Commons Clause components are explicitly approved; never use React Bits Pro.

### Color and logo tokens

Keep these values in `frontend/src/index.css`; do not introduce unrelated grays:

- Outer background `#c8c1b7`; shell `#faf8f5`; context `#f6f3ee`; card `#fffdfa`.
- Muted surface `#efebe5`; hover `#e7e1d8`; selected `#eae5dd`; border `#e3ddd4`.
- Primary text `#3c3732`; secondary text `#746d64`; primary action / toolbar logo `#302c28`; action hover `#494239`; focus ring `#8b7b69`.
- All four agent colors use OKLCH lightness 54% and chroma 0.055: planner hue 135, coder 55, verifier 325, supervisor 220. Compile and Sim remain warm gray.
- Status colors use OKLCH lightness 49% and chroma 0.085: PASS hue 145, FAIL 25, supervisor decision 80. Tinted status surfaces stay very close to neutral.
- The supplied SVG is implemented in `frontend/src/components/brand/Logo.tsx`, with `size` and `animated` props. Preserve its three paths, group the gear/ring, and use `currentColor`.
- Gear pivot comes from its actual path bounds: local `(2970.5, 2460)`, equivalent to viewBox `(297.05, 246)`. Never rotate around the full SVG's center.
- Use the logo in the toolbar, empty state, active agent row, active timeline status/event, and static favicon. Brand code is an explicitly approved exception to the component reuse rule and the agent/ directory convention.

## Project skill

- Frontend design guidance is installed at `.agents/skills/frontend-design/SKILL.md` from `anthropics/skills` under Apache-2.0. Read it when doing frontend design work. The user's design brief and component reuse rules take precedence over generic skill guidance.

## Frontend: existing components first

- Look up suitable components and exact registry names with the Watermelon MCP. Prefer Watermelon UI and React Bits; custom UI is allowed only when nothing fits and its reason is reported.
- Install Watermelon with `npx shadcn@latest add https://registry.watermelon.sh/r/<name>.json`; install React Bits with `npx shadcn@latest add @react-bits/<Name>-TS-TW`.
- Library-provided primitives installed as registry dependencies remain library code. Compose existing components before adding custom UI.
- If installation fails, report it. Do not claim it succeeded. Delete custom UI components replaced by successful registry installs.
- At completion, report UI part, library, registry item, actual install command, and file path.
- Adapt components to the design brief's colors, spacing, and density instead of retaining default marketing-site styling.
- Replace Next.js-specific imports such as `next/image` and `next/link` with plain React equivalents. Do not switch the project to Next.js.
- These component reuse rules apply only to the frontend. Backend and agent logic must be our own original code.

## Hackathon requirements

- This repository is public. Never commit API keys or tokens. Store secrets in local `.env` files and keep them ignored by Git. Any committed environment examples must contain placeholders only.
- Use only free, openly licensed components and assets. Never use paid or Pro components. Verify the license before adding anything external.
- Update `THIRD_PARTY.md` whenever an external component or library is added. Record its name, source, and license; include external assets as well.
- Make the distinction between hackathon work and library code clear to judges. Our original frontend work is playback, run-data wiring, event logic, layout, and any documented domain-specific UI. Backend and agent implementation remain original. Keep original and copied code clearly separated.
- Do not use Streamlit.
- The UI is a window into the agent system. Do not add dashboard filler, charts, or statistics that do not contribute to the agent story.
