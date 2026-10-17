# Demo and submission runbook

The delivery is localhost, the public repository, and a video. This document is a rehearsal plan; it is not a claim that the final workbench, video, or submission has been completed. The teammate owns the full workbench and recording. The backend and minimal integration harness are available now.

## Before presenting

1. Follow the README setup, run `npm run dev`, and check `/api/health` reports compiler availability.
2. For the live agent demonstration, configure the server-side Crusoe key and confirm the selected account model. Run `npx tsx scripts/smoke-run.ts` and retain a successful `inference: "crusoe"` report before describing live generation as demonstrated.
3. Rehearse the failure/repair path with `npx tsx scripts/smoke-run.ts --fixture` when needed. Keep **Offline fixture rehearsal · no AI** visible. This path compiles and simulates real firmware but uses reference source instead of inference.
4. Exercise the second goal with `npx tsx scripts/smoke-run.ts --buzzer` for real generation, or add `--fixture` for the separately labeled simulator rehearsal.
5. Run the checks, inspect an artifact ZIP, and confirm the published repository contains no credentials or generated run files.
6. Keep a previously recorded, explicitly labeled run available if provider access or network conditions fail. Never present a recording or fixture as a fresh agent run.

Only one run may be active. Budget for the controller's full three-minute maximum when planning rehearsal; provider latency can vary. Do not truncate or fabricate progress to fit a live slot.

## Three-minute live presentation

| Time | Action | What to explain |
|---|---|---|
| 0:00–0:20 | Show the airlock goal and start the labeled repair challenge | The published contract and baseline checks constrain the repair. The deterministic runner controls completion. |
| 0:20–0:45 | Open requirements/tests while the run advances | The Verifier selects two constrained mirror recipes without Builder code. Application code swaps door references while preserving the baseline's timing, checks, and requirements; the combined suite freezes before the first build. |
| 0:45–1:15 | Show the known-bad attempt and its real failure trace | This is an intentionally broken challenge sketch. Both door signals actually overlap; the failure is not invented. |
| 1:15–1:50 | Show diagnostics, repair activity, and the compiled rerun | The Builder receives concrete failures. Replans cannot weaken the frozen suite. Follow actual progress; if still running, explain its deadline and inspect the evidence already available. |
| 1:50–2:25 | After verification, enter live interaction and press each request | The browser executes the same compiled HEX. Observed GPIO drives the doors; a held button does not repeat and simultaneous requests are rejected. |
| 2:25–2:45 | Show evidence, hashes, and artifact download | The statement is “passing these listed simulator checks.” The badge belongs to this source, wiring, HEX, requirements, and tests. |
| 2:45–3:00 | Show a completed second-goal run and repository | The buzzer example demonstrates a distinct supported behavior. Identify whether its run used live inference or fixtures. |

The final rehearsal (`97875df7-c926-47ac-bb55-989f13efb98e`) passed all 99 checks on candidate 2 in 55.4 seconds, after the known-bad seed failed 71 checks. Both verified examples are available in the current delivery server session.

An earlier retained live airlock run (`b7785481-8917-4e91-ae7d-c123651ffac5`) completed in 89.4 seconds: the seed failed 71 checks, the first generated repair produced roughly 9–10 microsecond door pulses and failed, and candidate 3 passed all 99 checks. This provides a concrete example of transition-level simulation catching behavior a rendered animation could miss. Use its actual report and recorded traces when showing this completion.

The table is a presentation target, not a fabricated timing script. If a live repair has not finished, show its actual status and use a clearly labeled recorded completion if available. Never announce `VERIFIED` early.

The published airlock baseline checks startup, either door, automatic closure, simultaneous lockout until both buttons release, a held input, scripted bounce, alternating requests, discarded busy/cooldown requests, the measured closed interval, and reset. It has 86 checks across 12 scenarios, including simultaneous inputs at different GPIO sampling phases. A live challenge adds exactly two application-generated mirrored scenarios selected by the Verifier, giving 14 scenarios; the report's check count depends on the selected recipes. Fixture rehearsal runs the baseline alone. Do not describe the published baseline as model-generated tests.

Normal goals use independently generated tests followed by semantic review. A real Crusoe buzzer run passed 27 independently generated checks on candidate 2 in 53.1 seconds; see the README for its recorded run ID and evidence. Its generated circuit starts another round through simulator Reset. The separate three-button buzzer rehearsal fixture has 25 checks across four scenarios. Use the actual inspected run's behavior and report count in narration.

## One-minute video outline

| Time | Capture |
|---|---|
| 0:00–0:08 | Goal entry and one-sentence purpose: agents generate; simulation decides completion. |
| 0:08–0:18 | Published airlock requirements, unchanged baseline checks, and the two selected mirror recipes. |
| 0:18–0:30 | Clearly labeled known-bad airlock, recorded overlapping signals, and failed checks. |
| 0:30–0:42 | Actual Builder repair activity and rerun reaching its real terminal status. |
| 0:42–0:52 | Live buttons, observed door outputs, and hash-bound evidence/export. |
| 0:52–1:00 | Second supported goal, public repository, and library credits. |

Record actual activity and trace data. Time cuts are fine if visible and honest; distinguish playback from live interaction and fixtures from Crusoe inference. Avoid showing `.env`, account pages, or credentials. End with the repository link and credit Arduino CLI/core, AVR8js, React, Vite, TypeScript, Node, and Express. The final video still needs to be recorded and reviewed.

## October 17, 2026 checklist — Pacific time

- [ ] By **4:15 PM PT**: freeze features; run required checks; rehearse the three-minute presentation; retain verified live-run evidence if the submission claims live inference.
- [ ] Confirm the teammate workbench handles live controls, recorded failure, terminal failures, stale evidence, and artifact downloads.
- [ ] By **4:45 PM PT**: finish and review the one-minute video and submission text; confirm repository/video links work for judges.
- [ ] Submit **before 5:00 PM PT** and save the submission confirmation.

Submission text should identify what was built during this event, name the existing libraries, state the supported hardware scope, and describe verification as passing the listed simulator checks. The October 17 build began with no prior application source or commit history in this repository. The final submission should distinguish completed backend/harness work from teammate work as actually delivered.
