import { Router } from 'express';
import archiver from 'archiver';
import { z } from 'zod';
import type { HardwareProjectService } from './hardware-project.js';
import { connectedHardware, getDeviceProfile, installHardwarePackage, searchHardware } from './hardware-adapters.js';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const hardwareConfigurationSchema = z.object({
  fqbn: z.string().min(5).max(240).regex(/^[a-zA-Z0-9_:.=,-]+$/),
  bindings: z.array(z.object({ signalId: id, direction: z.enum(['input', 'output']), kind: z.enum(['serial', 'digital-input', 'analog-input', 'digital-output', 'pwm-output']), pin: z.string().max(60).optional(), component: z.string().trim().min(1).max(240), notes: z.string().max(2000).optional(), activeLow: z.boolean().optional(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict()).max(100),
  libraries: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,100}$/), version: z.string().regex(/^[a-zA-Z0-9_.+-]{1,40}$/).optional() }).strict()).max(30),
  baudRate: z.union([z.literal(9600), z.literal(19200), z.literal(38400), z.literal(57600), z.literal(115200)]),
  serialTimeoutMs: z.number().int().min(100).max(10000),
}).strict();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function hardwareCatalogRoutes() {
  const router = Router();
  router.get('/catalog', async (req, res) => {
    try { res.json(await searchHardware(String(req.query.q ?? '').slice(0, 160))); }
    catch (error) { res.status(503).json({ error: errorText(error) }); }
  });
  router.get('/profile', async (req, res) => {
    try { res.json(await getDeviceProfile(String(req.query.fqbn ?? ''), { install: true })); }
    catch (error) { res.status(400).json({ error: errorText(error) }); }
  });
  router.get('/devices', async (_req, res) => {
    try { res.json({ devices: await connectedHardware(), warnings: [] }); }
    catch (error) { res.status(503).json({ error: errorText(error) }); }
  });
  router.post('/packages', async (req, res) => {
    const input = z.object({ core: z.string().regex(/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/) }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Select a board package from the catalog.' }); return; }
    try { await installHardwarePackage(input.data.core); res.json(await searchHardware('')); }
    catch (error) { res.status(400).json({ error: errorText(error) }); }
  });
  return router;
}
export function hardwareProjectRoutes(service: HardwareProjectService) {
  const router = Router();
  router.get('/:id/hardware', async (req, res) => {
    try { res.json(await service.get(req.params.id)); }
    catch (error) { res.status(409).json({ error: errorText(error) }); }
  });
  router.put('/:id/hardware', async (req, res) => {
    const input = hardwareConfigurationSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: `Invalid hardware configuration: ${input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` }); return; }
    try { res.json(await service.configure(req.params.id, input.data)); }
    catch (error) { res.status(409).json({ error: errorText(error) }); }
  });
  router.post('/:id/hardware/build', async (req, res) => {
    if (req.body && Object.keys(req.body).length) { res.status(400).json({ error: 'Save hardware configuration before requesting a build.' }); return; }
    try { res.status(202).json(await service.build(req.params.id)); }
    catch (error) { res.status(409).json({ error: errorText(error) }); }
  });
  router.get('/:id/hardware/export', async (req, res) => {
    try {
      const files = await service.exportFiles(req.params.id);
      res.attachment(`hardware-project-${req.params.id}.zip`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
      archive.pipe(res);
      for (const [name, content] of Object.entries(files)) archive.append(content, { name });
      await archive.finalize();
    } catch (error) { if (!res.headersSent) res.status(409).json({ error: errorText(error) }); else res.end(); }
  });
  router.post('/:id/hardware/upload', async (req, res) => {
    const input = z.object({ port: z.string().min(1).max(240), confirm: z.literal(true) }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Explicitly select a connected device and request upload (confirm: true).' }); return; }
    try { res.json(await service.upload(req.params.id, input.data.port, input.data.confirm)); }
    catch (error) { res.status(409).json({ error: errorText(error) }); }
  });
  return router;
}
