# Third-party attribution

Current inventory for the reference redesign (2026-10-17).
Watermelon UI and React Bits supply reusable controls. Original frontend work
includes playback, data wiring, layout, domain-specific event/criteria rendering,
and the Shiki/jsdiff code viewer in `frontend/src/components/agent/`. The unchanged
mock fixture, backend, and agent implementation remain original project work.

All selected components are free. React Bits uses the explicitly approved
MIT + Commons Clause terms, not plain MIT. No Pro components or paid assets are used.

Actual CLI commands and installed paths are recorded in
[frontend/REGISTRY_COMPONENTS.md](frontend/REGISTRY_COMPONENTS.md).

## Copied components

| Component | Source | License | Used for |
| --- | --- | --- | --- |
| React Bits AnimatedList-TS-TW | [Registry](https://reactbits.dev/r/AnimatedList-TS-TW.json) | [MIT + Commons Clause](https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md) | Agent timeline list; `frontend/src/components/AnimatedList.tsx`. |
| Watermelon card-9 | [Registry](https://registry.watermelon.sh/r/card-9.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Panel containers and event rows; `frontend/src/components/watermelon/card-9.tsx`. |
| Watermelon card-10 | [Registry](https://registry.watermelon.sh/r/card-10.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Sketch / Test and Overview / Decisions tabs; `frontend/src/components/watermelon/card-10.tsx`. |
| Watermelon badge-12 | [Registry](https://registry.watermelon.sh/r/badge-12.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Status indicators; `frontend/src/components/watermelon/badge-12.tsx`. |
| React Bits CountUp-TS-TW | [Registry](https://reactbits.dev/r/CountUp-TS-TW.json) | [MIT + Commons Clause](https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md) | Attempt counter; `frontend/src/components/CountUp.tsx`. |
| Watermelon alert-12 | [Registry](https://registry.watermelon.sh/r/alert-12.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Supervisor decision; `frontend/src/components/watermelon/alert-12.tsx`. |
| Watermelon badge-1 | [Registry](https://registry.watermelon.sh/r/badge-1.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Header title and metadata labels; `frontend/src/components/watermelon/badge-1.tsx`. |
| Watermelon textarea-3 | [Registry](https://registry.watermelon.sh/r/textarea-3.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Serial readout and goal input; `frontend/src/components/watermelon/textarea-3.tsx`. |
| Watermelon button-1 | [Registry](https://registry.watermelon.sh/r/button-1.json) | [MIT](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE) | Run button; `frontend/src/components/watermelon/button-1.tsx`. |
| shadcn/ui base-nova primitives | [Source](https://github.com/shadcn-ui/ui) | MIT | Card, Tabs, Badge, Alert, Label, Textarea, Button installed by registry dependencies in `frontend/src/components/ui/`. |
| create-vite React/TypeScript scaffold | [Source](https://github.com/vitejs/vite) | MIT / CC0-1.0 template | Vite configuration and application bootstrap. |
| Anthropic frontend-design skill | [Source](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design) | Apache-2.0 | `.agents/skills/frontend-design/`, development guidance only. |

Registry components are reused and restyled. Data is supplied through props.
Card 10 uses a div instead of a paragraph for valid rich tab content; Alert 12 is
text-only. Button 1 exposes standard events for real interactions. AnimatedList's
existing render slot composes Watermelon items and retains the animation/selection
engine. Theme tokens live in `frontend/src/index.css`; layout and component styling
live in `frontend/src/components/agent/workspace.css`. No demo images are displayed.

## Code highlighting and comparison

| Library / asset | Source | License | Use |
| --- | --- | --- | --- |
| Shiki 4.5.0 | [Source](https://github.com/shikijs/shiki) | MIT | Requested C++ highlighting, lazily loaded in `highlight.ts` / `CodeReadout.tsx`. |
| Shiki C++ grammar | [Grammar notice](https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-grammars/NOTICE) | MIT (Microsoft / VS Code) | The C++ TextMate grammar distributed with Shiki. Its upstream notices are shipped with the frontend. |
| Shiki GitHub Light theme | [Theme notice](https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-themes/NOTICE) | MIT (Primer) | Light code colors; upstream notices shipped with the frontend. |
| jsdiff / diff 9.0.0 | [Source](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Line diff between arrived sketch attempts. |

## Fonts and icon assets

| Asset | Source | License | Use |
| --- | --- | --- | --- |
| IBM Plex Sans and IBM Plex Mono | [IBM Plex](https://github.com/IBM/plex), [license](https://github.com/IBM/plex/blob/master/LICENSE.txt) | SIL OFL-1.1 | Locally bundled through Fontsource; Sans for UI, Mono for code, serial output, counts, and timestamps. |
| Hugeicons free icons | [Hugeicons](https://github.com/hugeicons/hugeicons-react) | MIT, verified from installed package notices | AnimatedList's original default-item dependencies retained; no default demo icons are shown with project data. |

No Lucide or Geist dependency is used. The old Alert 12 Font Awesome icon is no longer rendered. No external image asset is loaded.
Complete notices for copied components, fonts, and icon dependencies are included
in [frontend/public/THIRD_PARTY_NOTICES.txt](frontend/public/THIRD_PARTY_NOTICES.txt)
and shipped by Vite in the production output.

### User-supplied project identity

The project owner supplied `1xwJeOx01.svg` for use as the app's logo. Its three
paths are preserved in `frontend/src/components/brand/Logo.tsx` and the static
`frontend/public/favicon.svg`. This is a user-provided asset, not a registry
component; no third-party license is asserted. The animation uses the existing
MIT-licensed Motion dependency. No additional package was installed for this pass.

## Direct packages

Versions and licenses below come from installed package metadata.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `@base-ui/react` | 1.9.0 | MIT | [Source](https://github.com/mui/base-ui) |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 | [Source](https://github.com/fontsource/font-files) |
| `@fontsource/ibm-plex-sans` | 5.3.0 | OFL-1.1 | [Source](https://github.com/fontsource/font-files) |
| `@hugeicons/core-free-icons` | 4.3.5 | MIT | [Source](https://github.com/hugeicons/hugeicons) |
| `@hugeicons/react` | 1.1.10 | MIT | [Source](https://github.com/hugeicons/hugeicons) |
| `@tailwindcss/vite` | 4.3.3 | MIT | [Source](https://github.com/tailwindlabs/tailwindcss) |
| `@types/node` | 24.19.2 | MIT | [Source](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react` | 19.3.0 | MIT | [Source](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react-dom` | 19.3.0 | MIT | [Source](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@vitejs/plugin-react` | 6.1.2 | MIT | [Source](https://github.com/vitejs/vite-plugin-react) |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | [Source](https://github.com/joe-bell/cva) |
| `cn` | 0.5.0 | MIT | [Source](https://github.com/shadcn-ui/cn) |
| `motion` | 12.43.0 | MIT | [Source](https://github.com/motiondivision/motion) |
| `oxlint` | 1.88.0 | MIT | [Source](https://github.com/oxc-project/oxc) |
| `react` | 19.3.1 | MIT | [Source](https://github.com/react/react) |
| `react-dom` | 19.3.1 | MIT | [Source](https://github.com/react/react) |
| `react-icons` | 5.7.0 | MIT | [Source](ssh://git@github.com:react-icons/react-icons) |
| `shadcn` | 4.22.0 | MIT | [Source](https://github.com/shadcn-ui/ui) |
| `tailwindcss` | 4.3.3 | MIT | [Source](https://github.com/tailwindlabs/tailwindcss) |
| `tw-animate-css` | 1.4.0 | MIT | [Source](Wombosvideo/tw-animate-css) |
| `typescript` | 6.0.3 | Apache-2.0 | [Source](https://github.com/microsoft/TypeScript) |
| `vite` | 8.3.4 | MIT | [Source](https://github.com/vitejs/vite) |
| `shiki` | 4.5.0 | MIT | [Source](https://github.com/shikijs/shiki) |
| `diff` | 9.0.0 | BSD-3-Clause | [Source](https://github.com/kpdecker/jsdiff) |
