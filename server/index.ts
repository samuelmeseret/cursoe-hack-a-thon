import 'dotenv/config';
import express from 'express';
import archiver from 'archiver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { RunController } from './controller.js';
import { compilerAvailable } from './compiler.js';
import { artifactDirectory, json } from './storage.js';
import { circuitSvg } from './diagram.js';
import type { RunEvent } from '../shared/types.js';
import { simulationRoutes } from './simulation-routes.js';
import { hardwareCatalogRoutes } from './hardware-routes.js';

export function createApp(controller = new RunController()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { res.status(403).json({ error: 'This workbench accepts local browser requests only.' }); return; }
      } catch { res.status(403).json({ error: 'Invalid origin.' }); return; }
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', async (_req, res) => {
    res.json({ status: 'ok', model: process.env.CRUSOE_MODEL || 'deepseek-ai/Deepseek-V4-Flash', keyConfigured: Boolean(process.env.CRUSOE_API_KEY), compilerAvailable: await compilerAvailable(), artifactDirectory });
  });
  app.use('/api/simulations', simulationRoutes());
  app.use('/api/hardware', hardwareCatalogRoutes());
  const startSchema = z.object({ goal: z.string().trim().min(5).max(5000), mode: z.enum(['generate', 'airlock-repair']), inference: z.enum(['crusoe', 'fixture']).optional() }).strict();
  app.post('/api/runs', async (req, res) => {
    const input = startSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Provide a goal (5–5000 characters), mode (generate or airlock-repair), and optional inference (crusoe or fixture).' }); return; }
    try { res.status(202).json(await controller.start(input.data)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to start run' }); }
  });
  app.get('/api/runs/:id', async (req, res) => {
    const run = await controller.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'Run not found in this server session.' }); return; }
    res.json(run);
  });
  app.post('/api/runs/:id/cancel', async (req, res) => {
    const run = await controller.cancel(req.params.id);
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    res.json(run);
  });
  app.get('/api/runs/:id/events', async (req, res) => {
    const run = await controller.get(req.params.id);
    if (res.destroyed) return;
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const after = Number(req.headers['last-event-id'] || req.query.after || 0);
    let lastSent = Number.isFinite(after) ? after : 0;
    const send = (event: RunEvent) => {
      if (event.sequence <= lastSent) return;
      lastSent = event.sequence;
      res.write(`id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const buffered: RunEvent[] = [];
    let snapshotSent = false;
    const onEvent = (event: RunEvent) => { if (snapshotSent) send(event); else buffered.push(event); };
    controller.events.on(req.params.id, onEvent);
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    res.once('close', () => { closed = true; clearInterval(heartbeat); controller.events.off(req.params.id, onEvent); });
    // Read after subscribing so no event can be lost between snapshot and subscription.
    const current = await controller.get(req.params.id);
    if (closed) return;
    current?.events.forEach(send);
    buffered.sort((a, b) => a.sequence - b.sequence).forEach(send);
    snapshotSent = true;
    heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  });
  app.get('/api/runs/:id/artifacts', async (req, res) => {
    const run = await controller.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    if (!['VERIFIED', 'FAILED', 'STALE', 'CANCELLED'].includes(run.status)) { res.status(409).json({ error: 'Artifacts are available when the run stops.' }); return; }
    res.attachment(`airlock-lab-${run.id}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    archive.pipe(res);
    // Snapshot buffers prevent disk edits during streaming from mixing artifacts and evidence.
    const artifacts: Record<string, string | undefined> = {
      'sketch.ino': run.candidate?.source, 'circuit.json': run.circuit ? json(run.circuit) : undefined,
      'circuit.svg': run.circuit ? circuitSvg(run.circuit) : undefined, 'firmware.hex': run.hex,
      'requirements.json': run.spec ? json(run.spec) : undefined, 'tests.json': run.scenarios ? json(run.scenarios) : undefined,
    };
    for (const [name, content] of Object.entries(artifacts)) if (content !== undefined) archive.append(content, { name });
    archive.append(JSON.stringify({ status: run.status, error: run.error, errorCode: run.errorCode, inference: run.inference, model: run.model, statement: 'Passing the listed simulator checks is not a claim about physical hardware.', evidence: run.evidence, originalFailure: run.failureEvidence, attempts: run.attempts, events: run.events }, null, 2), { name: 'verification-report.json' });
    await archive.finalize();
  });
  const web = path.resolve('dist/client');
  if (existsSync(path.join(web, 'index.html'))) { app.use(express.static(web)); app.get('/{*path}', (_req, res) => res.sendFile(path.join(web, 'index.html'))); }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof SyntaxError ? 'Malformed JSON request.' : 'Request failed.' });
  });
  return { app, controller };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  const { app } = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`Simulation Lab API: http://127.0.0.1:${port}`));
}
