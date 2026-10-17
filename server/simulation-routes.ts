import { Router } from 'express';
import archiver from 'archiver';
import { z } from 'zod';
import { SimulationController } from './simulation-controller.js';
import { simulationTerminal, type SimulationRunEvent } from '../shared/simulation-run.js';
import { buildSimulationDocument } from '../shared/simulation-runtime.js';
import { HardwareProjectService } from './hardware-project.js';
import { hardwareProjectRoutes } from './hardware-routes.js';

export function simulationRoutes(controller = new SimulationController(), hardware = new HardwareProjectService(controller)) {
  const router = Router();
  router.use(hardwareProjectRoutes(hardware));
  const startSchema = z.object({ prompt: z.string().trim().min(5).max(5000), previousId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/).optional() }).strict();
  router.post('/', async (req, res) => {
    const request = startSchema.safeParse(req.body);
    if (!request.success) { res.status(400).json({ error: 'Provide a prompt of 5–5000 characters and an optional previous simulation ID.' }); return; }
    try { res.status(202).json(await controller.start(request.data)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to start simulation.' }); }
  });
  router.get('/:id', async (req, res) => {
    const run = await controller.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'Simulation not found.' }); return; }
    res.json(run);
  });
  router.post('/:id/cancel', async (req, res) => {
    const run = await controller.cancel(req.params.id);
    if (!run) { res.status(404).json({ error: 'Simulation not found.' }); return; }
    res.json(run);
  });
  router.get('/:id/events', async (req, res) => {
    const id = req.params.id;
    if (!await controller.get(id)) { res.status(404).json({ error: 'Simulation not found.' }); return; }
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    const after = Number(req.headers['last-event-id'] || req.query.after || 0);
    let last = Number.isFinite(after) ? after : 0;
    let ready = false;
    let closed = false;
    const buffered: SimulationRunEvent[] = [];
    const send = (event: SimulationRunEvent) => {
      if (event.sequence <= last || closed) return;
      last = event.sequence; res.write(`id: ${event.sequence}\nevent: simulation-event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const receive = (event: SimulationRunEvent) => { if (ready) send(event); else buffered.push(event); };
    controller.events.on(id, receive);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    res.once('close', () => { closed = true; clearInterval(heartbeat); controller.events.off(id, receive); });
    const current = await controller.get(id);
    if (closed) return;
    current?.events.forEach(send); buffered.sort((a, b) => a.sequence - b.sequence).forEach(send); ready = true;
  });
  router.get('/:id/artifacts', async (req, res) => {
    const run = await controller.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'Simulation not found.' }); return; }
    if (!simulationTerminal(run.status)) { res.status(409).json({ error: 'Wait for the build to finish before downloading.' }); return; }
    res.attachment(`simulation-${run.id}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    archive.pipe(res);
    if (run.spec) archive.append(JSON.stringify(run.spec, null, 2), { name: 'specification.json' });
    if (run.scenarios) archive.append(JSON.stringify(run.scenarios, null, 2), { name: 'scenarios.json' });
    if (run.candidate) archive.append(run.candidate.source, { name: 'simulation.js' });
    if (run.candidate && run.spec) archive.append(buildSimulationDocument({ spec: run.spec, candidate: run.candidate }, { standalone: true }), { name: 'simulation.html' });
    archive.append(JSON.stringify({ status: run.status, prompt: run.prompt, model: run.model, evidence: run.evidence, draftEvidence: run.draftEvidence, attempts: run.attempts, error: run.error, errorCode: run.errorCode, errorFinishReason: run.errorFinishReason, warning: run.warning, events: run.events }, null, 2), { name: 'verification-report.json' });
    await archive.finalize();
  });
  return router;
}
