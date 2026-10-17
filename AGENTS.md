# Project rules

## Frontend: use existing components first

- Before building any UI element from scratch, check for a suitable ready-made component in shadcn/ui, Aceternity UI, Cult UI, React Bits, Watermelon UI, Motion UI, and uncommon shadcn extension libraries.
- Use shadcn/ui by default for basics such as cards, tabs, badges, buttons, inputs, and scroll areas.
- Use a suitable existing component when one exists. Build from scratch only when none fits, and tell the user what was built and why.
- Adapt components to the design brief's colors, spacing, and density instead of retaining default marketing-site styling.
- Replace Next.js-specific imports such as `next/image` and `next/link` with plain React equivalents. Do not switch the project to Next.js.
- These component reuse rules apply only to the frontend. Backend and agent logic must be our own original code.

## Hackathon requirements

- This repository is public. Never commit API keys or tokens. Store secrets in local `.env` files and keep them ignored by Git. Any committed environment examples must contain placeholders only.
- Use only free, openly licensed components and assets. Never use paid or Pro components. Verify the license before adding anything external.
- Update `THIRD_PARTY.md` whenever an external component or library is added. Record its name, source, and license; include external assets as well.
- Make the distinction between hackathon work and library code clear to judges. Our original work includes the agent timeline logic, event system, checklist/verification views, and backend integration. Keep these in clearly named files, separate from copied components.
- Do not use Streamlit.
- The UI is a window into the agent system. Do not add dashboard filler, charts, or statistics that do not contribute to the agent story.
- Make small, frequent commits with clear messages so the history shows when the hackathon work was done.
