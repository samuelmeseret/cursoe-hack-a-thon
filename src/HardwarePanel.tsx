import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HardwareBinding, HardwareConfiguration, HardwareProjectState, BindingKind } from '../shared/hardware-project';
import type { BoardCatalogEntry, ConnectedDevice, HardwareCatalog, HardwareProfile } from '../shared/hardware-types';
import { simulationTerminal, type SimulationRun } from '../shared/simulation-run';
import './hardware-panel.css';

async function hardwareApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => { throw new Error('The hardware service did not return a usable response. Try again when the local server is available.'); });
  if (!response.ok) throw new Error(data.error ?? `Hardware request failed (${response.status}).`);
  return data;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const jsonRequest = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const bindingLabels: Record<BindingKind, string> = { serial: 'USB / serial', 'digital-input': 'Digital input', 'analog-input': 'Analog input', 'digital-output': 'Digital output', 'pwm-output': 'PWM output' };

export function HardwarePanel({ run, busy = false, onPrepareController }: { run: SimulationRun; busy?: boolean; onPrepareController?: () => void }) {
  const controller = run.candidate?.controller;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<HardwareProjectState>();
  const [stateArtifact, setStateArtifact] = useState('');
  const [draft, setDraft] = useState<HardwareConfiguration>();
  const [profile, setProfile] = useState<HardwareProfile>();
  const [query, setQuery] = useState('');
  const [fqbn, setFqbn] = useState('');
  const [catalog, setCatalog] = useState<HardwareCatalog>();
  const [devices, setDevices] = useState<ConnectedDevice[]>();
  const [deviceWarnings, setDeviceWarnings] = useState<string[]>([]);
  const [port, setPort] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestSequence = useRef(0);
  const alive = useRef(true);
  const stateRef = useRef<HardwareProjectState | undefined>(undefined);
  const requests = useRef(new Set<AbortController>());
  const endpoint = `/api/simulations/${encodeURIComponent(run.id)}/hardware`;
  const artifactIdentity = JSON.stringify([run.candidate, run.spec, run.scenarios]);
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(state?.configuration));
  const building = state?.status === 'BUILDING';
  const locked = busy || building || Boolean(pending);
  const savedEvidence = !dirty && stateArtifact === artifactIdentity && state?.status !== 'STALE' ? state?.evidence : undefined;
  const canExport = Boolean(state?.status === 'COMPILED' && savedEvidence?.compiled && savedEvidence.controllerParity);
  const canUpload = canExport && Boolean(savedEvidence?.simulationChecked);
  const signals = controller ? [...controller.inputs.map(signal => ({ ...signal, direction: 'input' as const })), ...controller.outputs.map(signal => ({ ...signal, direction: 'output' as const }))] : [];

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestSequence.current++;
      for (const request of requests.current) request.abort();
    };
  }, []);

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const abort = new AbortController();
    requests.current.add(abort);
    try { return await hardwareApi<T>(path, { ...init, signal: abort.signal }); }
    finally { requests.current.delete(abort); }
  };
  const acceptState = (next: HardwareProjectState, replaceDraft = false) => {
    if (!alive.current || next.revisionId !== run.id) return;
    const previous = stateRef.current;
    if (previous && next.updatedAt < previous.updatedAt) return;
    stateRef.current = next;
    setState(next);
    setStateArtifact(artifactIdentity);
    if (replaceDraft) { setDraft(next.configuration); setProfile(next.profile); setFqbn(next.configuration?.fqbn ?? ''); }
  };

  useEffect(() => {
    if (!open || !controller) return;
    const sequence = ++requestSequence.current;
    let cancelled = false;
    setPending('Loading hardware configuration…');
    request<HardwareProjectState>(endpoint).then(next => {
      if (!cancelled && sequence === requestSequence.current) acceptState(next, !draft || !dirty);
    }).catch(reason => { if (!cancelled && alive.current) setError(errorMessage(reason)); })
      .finally(() => { if (!cancelled && alive.current) setPending(''); });
    return () => { cancelled = true; };
  }, [open, run.id, Boolean(controller), artifactIdentity]);

  useEffect(() => {
    if (!open || !building) return;
    let cancelled = false;
    let timeout: number | undefined;
    const refresh = async () => {
      const sequence = ++requestSequence.current;
      try {
        const next = await request<HardwareProjectState>(endpoint);
        if (!cancelled && sequence === requestSequence.current) { acceptState(next); setError(''); }
      } catch (reason) { if (!cancelled && alive.current) setError(errorMessage(reason)); }
      if (!cancelled) timeout = window.setTimeout(refresh, 2000);
    };
    timeout = window.setTimeout(refresh, 1200);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [open, building, run.id, artifactIdentity]);

  function defaultConfiguration(target: string): HardwareConfiguration {
    return {
      fqbn: target,
      bindings: signals.map(signal => ({ signalId: signal.id, direction: signal.direction, kind: signal.hardware.kind, component: signal.hardware.component ?? signal.label, notes: signal.hardware.description, ...(signal.hardware.kind === 'analog-input' ? { minimum: signal.hardware.min ?? 0, maximum: signal.hardware.max ?? 1 } : {}) })),
      libraries: [], baudRate: 115200, serialTimeoutMs: 500,
    };
  }
  function changeConfiguration(update: (current: HardwareConfiguration) => HardwareConfiguration) {
    setDraft(current => current ? update(current) : current);
    setNotice(''); setError('');
  }
  function updateBinding(index: number, update: Partial<HardwareBinding>) {
    changeConfiguration(current => ({ ...current, bindings: current.bindings.map((binding, i) => i === index ? { ...binding, ...update } : binding) }));
  }
  async function perform(label: string, action: () => Promise<void>) {
    setPending(label); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setPending(''); }
  }
  async function search(event?: FormEvent) {
    event?.preventDefault();
    await perform('Searching board package catalogs…', async () => {
      const next = await request<HardwareCatalog>(`/api/hardware/catalog?q=${encodeURIComponent(query.trim())}`);
      if (alive.current) setCatalog(next);
    });
  }
  async function chooseBoard(target: string, selectedPort = '') {
    await perform('Resolving the board and installing its package if needed…', async () => {
      const next = await request<HardwareProfile>(`/api/hardware/profile?fqbn=${encodeURIComponent(target)}`);
      if (!alive.current) return;
      setProfile(next); setFqbn(next.fqbn); setPort(selectedPort);
      setDraft(current => ({ ...(current ?? defaultConfiguration(next.fqbn)), fqbn: next.fqbn }));
      setNotice(`Selected ${next.name}. Review its pins and components, then save the configuration.`);
    });
  }
  async function installBoard(board: BoardCatalogEntry) {
    await perform(`Installing ${board.core}…`, async () => {
      await request<HardwareCatalog>('/api/hardware/packages', jsonRequest('POST', { core: board.core }));
      const next = await request<HardwareCatalog>(`/api/hardware/catalog?q=${encodeURIComponent(query.trim() || board.name)}`);
      if (alive.current) { setCatalog(next); setNotice('Board package installed. Select your exact board from the updated results.'); }
    });
  }
  async function findDevices() {
    await perform('Looking for connected hardware…', async () => {
      const next = await request<{ devices: ConnectedDevice[]; warnings: string[] }>('/api/hardware/devices');
      if (alive.current) { setDevices(next.devices); setDeviceWarnings(next.warnings ?? []); }
    });
  }
  async function save() {
    if (!draft) return;
    const sequence = ++requestSequence.current;
    await perform('Checking and saving hardware configuration…', async () => {
      const next = await request<HardwareProjectState>(endpoint, jsonRequest('PUT', draft));
      if (!alive.current || sequence !== requestSequence.current) return;
      acceptState(next, true);
      setNotice(next.issues.length ? 'Configuration saved with requirements to resolve before building.' : 'Configuration saved. Build and check this revision when ready.');
    });
  }
  async function build() {
    const sequence = ++requestSequence.current;
    await perform('Starting the real toolchain build…', async () => {
      const next = await request<HardwareProjectState>(`${endpoint}/build`, jsonRequest('POST'));
      if (sequence === requestSequence.current) acceptState(next);
    });
  }
  async function upload() {
    if (!port || !canUpload || !profile?.uploadSupported) return;
    await perform(`Uploading to ${port}…`, async () => {
      const next = await request<HardwareProjectState>(`${endpoint}/upload`, jsonRequest('POST', { port, confirm: true }));
      acceptState(next);
      if (alive.current) setNotice('Upload completed. Physical behavior still needs to be tested on the device.');
    });
  }

  const serialInputs = draft?.bindings.filter(binding => binding.direction === 'input' && binding.kind === 'serial') ?? [];
  const inputKeys = run.spec?.controls.filter(control => control.type === 'key' && serialInputs.some(binding => binding.signalId === control.id)) ?? [];
  const missingPins = draft?.bindings.filter(binding => binding.kind !== 'serial' && !binding.pin).map(binding => `${binding.component || binding.signalId} needs a pin.`) ?? [];
  const unsupported = profile?.supported === false;
  const issues = [...new Set([...(profile?.missingCapabilities ?? []), ...missingPins, ...(!dirty ? state?.issues ?? [] : [])])];
  const uploadDevices = devices?.filter(device => device.boards.length === 0 || device.boards.some(board => board.fqbn.split(':').slice(0, 3).join(':') === profile?.fqbn.split(':').slice(0, 3).join(':'))) ?? [];

  return <section className="hardware-panel" id="project-hardware" aria-labelledby="hardware-heading">
    <div className="hardware-heading"><div><h2 id="hardware-heading">Bring this project to hardware</h2><p>The controller you simulate becomes the controller on your device.</p></div><button type="button" aria-expanded={open} aria-controls="hardware-workflow" disabled={busy} onClick={() => setOpen(value => !value)}>{open ? 'Hide hardware' : state?.configuration ? 'Configure hardware' : 'Choose hardware'}</button></div>
    {open && <div id="hardware-workflow">
      {!controller ? <div className="hardware-missing">
        <h3>This simulation needs a portable controller</h3>
        <p>{run.candidate?.hardwareUnavailableReason ?? 'This revision stores its behavior in browser code. Create a new revision that shares its device controller between the simulation and hardware.'}</p>
        {onPrepareController && run.candidate && run.spec && simulationTerminal(run.status) && <button type="button" className="primary" disabled={locked} onClick={onPrepareController}>Create portable controller</button>}
        <p className="muted">No firmware has been generated or compiled for this revision.</p>
      </div> : <>
        <ol className="hardware-progress" aria-label="Hardware workflow"><li aria-current={!draft ? 'step' : undefined}>Choose hardware</li><li aria-current={draft && (!state?.configuration || dirty) ? 'step' : undefined}>Configure</li><li aria-current={state?.configuration && !dirty && !canExport ? 'step' : undefined}>Build & check</li><li aria-current={canExport ? 'step' : undefined}>Export</li></ol>
        <div className="hardware-verification" aria-label="Verification status">
          <span data-passed={Boolean(savedEvidence?.generated)}>Generated{savedEvidence?.generated ? '' : ' · pending'}</span>
          <span data-passed={Boolean(savedEvidence?.compiled)}>Compiled{savedEvidence?.compiled ? '' : ' · pending'}</span>
          <span data-passed={Boolean(savedEvidence?.simulationChecked)}>Simulation checked{savedEvidence?.simulationChecked ? '' : ' · pending'}</span>
          <span>Physical hardware · untested</span>
        </div>
        {dirty && state?.evidence && <p className="hardware-notice">Configuration changed. Previous build and check results do not apply until you save and rebuild.</p>}
        {state?.status === 'STALE' && <p className="hardware-notice">This project changed. Rebuild this revision to generate current firmware and checks.</p>}
        <section className="hardware-section" aria-label="Choose your board">
          <div className="hardware-section-heading"><h3>Choose your board</h3><button type="button" disabled={locked} onClick={findDevices}>Find connected devices</button></div>
          <p>Search real toolchain catalogs, or enter your board’s fully qualified name. Required board packages can be installed here.</p>
          <form className="hardware-search" onSubmit={search}><label htmlFor="board-search">Board or device name</label><div><input id="board-search" type="search" value={query} placeholder="Search for your exact board" onChange={event => setQuery(event.target.value)} disabled={locked}/><button type="submit" disabled={locked}>Search catalog</button></div></form>
          {catalog && <div className="hardware-catalog"><p className="muted">{catalog.boards.length} matching {catalog.boards.length === 1 ? 'board' : 'boards'}</p>{catalog.warnings.map((warning, index) => <p className="hardware-notice" key={index}>{warning}</p>)}{catalog.boards.length === 0 && <p>No matching board was found in the available indexes. Check the model name or enter its exact FQBN below.</p>}<ul>{catalog.boards.map(board => <li key={board.id}><div><strong>{board.name}</strong><small>{board.architecture} · {board.core}{board.version ? ` ${board.version}` : ''} · {board.installed ? 'Installed' : 'Package required'}</small>{board.fqbn && <code>{board.fqbn}</code>}{board.missingCapabilities.length > 0 && <p className="hardware-notice">{board.missingCapabilities.join(' ')}</p>}</div><button type="button" disabled={locked} onClick={() => board.fqbn ? chooseBoard(board.fqbn) : installBoard(board)}>{board.fqbn ? 'Select board' : 'Install board package'}</button></li>)}</ul></div>}
          <details className="hardware-exact"><summary>Use an exact board identifier (FQBN)</summary><form className="hardware-search" onSubmit={event => { event.preventDefault(); void chooseBoard(fqbn.trim()); }}><label htmlFor="board-fqbn">Fully qualified board name</label><div><input id="board-fqbn" value={fqbn} onChange={event => setFqbn(event.target.value)} placeholder="package:architecture:board" disabled={locked}/><button type="submit" disabled={locked || fqbn.split(':').length < 3}>Resolve board</button></div></form></details>
          {devices && <div className="hardware-devices"><h4>Connected devices</h4>{deviceWarnings.map((warning, index) => <p className="hardware-notice" key={index}>{warning}</p>)}{devices.length === 0 ? <p>No devices were detected by the local toolchain. You can still configure, compile, and export a project.</p> : <ul>{devices.map(device => <li key={device.port}><div><strong>{device.label}</strong><code>{device.port}</code><small>{device.protocol}{!device.identified ? ' · Board could not be identified; select its exact model from the catalog.' : ''}</small></div>{device.boards.map(board => <button type="button" disabled={locked} key={board.fqbn} onClick={() => chooseBoard(board.fqbn, device.port)}>Use {board.name}</button>)}</li>)}</ul>}</div>}
        </section>
        {profile && draft && <>
          <section className="hardware-section" aria-label="Hardware configuration"><div className="hardware-profile"><h3>{profile.name}</h3><code>{profile.fqbn}</code><dl><div><dt>Architecture</dt><dd>{profile.architecture}</dd></div><div><dt>Runtime</dt><dd>{profile.framework}</dd></div><div><dt>Toolchain</dt><dd>{profile.toolchain}</dd></div><div><dt>Board package</dt><dd>{profile.core} {profile.version}</dd></div></dl><p className="muted">{profile.capabilities.join(' · ')}</p><details><summary>Board constraints and metadata</summary><ul>{profile.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul><p>Interfaces: {profile.interfaces.join(', ') || 'No interfaces reported'}</p>{profile.metadataSources.map(source => <p key={source}><code>{source}</code></p>)}</details></div>
            {profile.options.length > 0 && <div className="hardware-board-options">{profile.options.map(option => <label key={option.id}>{option.label}<select disabled={locked} value={option.values.find(value => value.selected)?.id ?? ''} onChange={event => { const [vendor, architecture, board, settings = ''] = profile.fqbn.split(':'); const selections = new Map(settings.split(',').filter(Boolean).map(setting => setting.split('=') as [string, string])); selections.set(option.id, event.target.value); void chooseBoard(`${vendor}:${architecture}:${board}:${[...selections].map(([key, value]) => `${key}=${value}`).join(',')}`); }}>{option.values.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>)}</div>}
            <h3 className="hardware-subheading">Components, pins & interfaces</h3><p>Each row connects a signal from the shared controller to a physical component or the computer-side serial connection.</p>
            <div className="hardware-bindings">{draft.bindings.map((binding, index) => {
              const signal = signals.find(item => item.id === binding.signalId && item.direction === binding.direction);
              const kinds: BindingKind[] = binding.direction === 'input' ? signal?.type === 'boolean' ? ['serial', 'digital-input'] : ['serial', 'analog-input'] : signal?.type === 'boolean' ? ['digital-output', 'serial'] : ['pwm-output', 'serial'];
              const pins = profile.pins.filter(pin => binding.kind === 'analog-input' ? pin.analog : binding.kind === 'pwm-output' ? pin.pwm : pin.digital);
              const name = signal?.label ?? binding.signalId;
              return <fieldset className="hardware-binding" key={`${binding.direction}:${binding.signalId}`} disabled={locked}><legend>{name}<small>{binding.direction} · {binding.signalId}</small></legend><div className="hardware-binding-fields"><label>Component<input aria-label={`${name} component`} value={binding.component} onChange={event => updateBinding(index, { component: event.target.value })}/></label><label>Interface<select aria-label={`${name} interface`} value={binding.kind} onChange={event => updateBinding(index, { kind: event.target.value as BindingKind, pin: undefined, ...(event.target.value === 'analog-input' ? { minimum: signal?.hardware.min ?? 0, maximum: signal?.hardware.max ?? 1 } : {}) })}>{kinds.map(kind => <option key={kind} value={kind}>{bindingLabels[kind]}</option>)}</select></label><label>Pin<select aria-label={`${name} pin`} value={binding.pin ?? ''} disabled={binding.kind === 'serial'} onChange={event => updateBinding(index, { pin: event.target.value || undefined })}><option value="">{binding.kind === 'serial' ? 'Serial connection' : 'Choose a pin'}</option>{binding.pin && !pins.some(pin => pin.id === binding.pin) && <option value={binding.pin}>{binding.pin} · not available on this board</option>}{pins.map(pin => <option key={pin.id} value={pin.id} disabled={Boolean(pin.reserved)}>{pin.label}{pin.reserved ? ` · ${pin.reserved}` : ''}</option>)}</select></label></div>{binding.kind === 'analog-input' && <div className="hardware-range"><label>Reading at ADC zero<input type="number" step="any" aria-label={`${name} minimum`} value={binding.minimum ?? 0} onChange={event => updateBinding(index, { minimum: Number(event.target.value) })}/></label><label>Reading at ADC maximum<input type="number" step="any" aria-label={`${name} maximum`} value={binding.maximum ?? 1} onChange={event => updateBinding(index, { maximum: Number(event.target.value) })}/></label></div>}{['digital-input', 'digital-output'].includes(binding.kind) && <label className="hardware-checkbox"><input type="checkbox" checked={Boolean(binding.activeLow)} onChange={event => updateBinding(index, { activeLow: event.target.checked })}/>Active low{binding.kind === 'digital-input' ? ' (internal pull-up)' : ''}</label>}<label className="hardware-binding-note">Wiring notes<input aria-label={`${name} wiring notes`} value={binding.notes ?? ''} placeholder="Connection, supply, or component requirements" onChange={event => updateBinding(index, { notes: event.target.value })}/></label></fieldset>;
            })}</div>
            <details className="hardware-communication" open={serialInputs.length > 0}><summary>Communication & dependencies</summary><div className="hardware-serial-settings"><label>Serial baud rate<select disabled={locked} value={draft.baudRate} onChange={event => changeConfiguration(current => ({ ...current, baudRate: Number(event.target.value) }))}>{[9600, 19200, 38400, 57600, 115200].map(rate => <option key={rate} value={rate}>{rate}</option>)}</select></label><label>Connection timeout (ms)<input type="number" min={100} max={10000} step={100} disabled={locked} value={draft.serialTimeoutMs} onChange={event => changeConfiguration(current => ({ ...current, serialTimeoutMs: Number(event.target.value) }))}/></label></div>{serialInputs.length > 0 && <p className="hardware-notice">{inputKeys.length ? 'Keyboard input runs through a computer-side companion in the exported project.' : 'Computer-controlled inputs use the serial companion in the exported project.'} Connect the board by USB, then run the companion with its serial port. Browser controls do not send commands to physical hardware. Inputs return to their declared initial values when the connection times out.</p>}<div className="hardware-libraries"><h4>Required libraries</h4><p className="muted">Libraries are installed from the toolchain catalog and their versions are recorded in the export. Additional device protocols also need a compatible driver adapter; installing a library alone does not implement one.</p>{draft.libraries.length === 0 && <p>No additional libraries configured.</p>}{draft.libraries.map((library, index) => <div className="hardware-library" key={index}><label>Library name<input aria-label={`Library ${index + 1} name`} disabled={locked} value={library.name} onChange={event => changeConfiguration(current => ({ ...current, libraries: current.libraries.map((item, i) => i === index ? { ...item, name: event.target.value } : item) }))}/></label><label>Version<input aria-label={`Library ${index + 1} version`} disabled={locked} value={library.version ?? ''} placeholder="Latest available" onChange={event => changeConfiguration(current => ({ ...current, libraries: current.libraries.map((item, i) => i === index ? { ...item, version: event.target.value || undefined } : item) }))}/></label><button type="button" disabled={locked} aria-label={`Remove library ${index + 1}`} onClick={() => changeConfiguration(current => ({ ...current, libraries: current.libraries.filter((_, i) => i !== index) }))}>Remove</button></div>)}<button type="button" disabled={locked} onClick={() => changeConfiguration(current => ({ ...current, libraries: [...current.libraries, { name: '' }] }))}>Add library</button></div></details>
          </section>
          <section className="hardware-section hardware-build" aria-label="Build and export"><h3>Build, check & export</h3><p>The build generates the device project, runs the selected toolchain, and compares the compiled controller with the simulation’s behavior checks.</p>{issues.length > 0 && <div className="hardware-issues" role="status"><strong>{unsupported ? 'This board needs additional support' : 'Requirements to resolve'}</strong><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}<div className="hardware-actions"><button type="button" disabled={locked || !dirty} onClick={save}>Save configuration</button><button type="button" className="primary" disabled={locked || dirty || unsupported || !state?.configuration || issues.length > 0} onClick={build}>{building ? 'Building & checking…' : 'Build & check'}</button>{canExport && <a className="hardware-export" href={`${endpoint}/export`}>{savedEvidence?.simulationChecked ? 'Download hardware project ZIP' : 'Download compiled draft ZIP'}</a>}</div>{!canExport && <p className="muted">{dirty ? 'Save this configuration before building. ' : ''}Hardware export is available after compilation and controller parity checks pass. Until then, this is a draft.</p>}{canExport && !savedEvidence?.simulationChecked && <p className="hardware-notice">Compiled draft: the device toolchain and controller comparison passed, but simulation requirements are not fully verified. The ZIP preserves this draft status. Resolve behavior checks before requesting an upload.</p>}{savedEvidence && <p className="hardware-evidence">{savedEvidence.statement} {savedEvidence.parityChecks} controller comparison checks. Physical hardware has not been tested.</p>}{state?.error && <p className="hardware-error" role="alert">{state.error}</p>}{state?.log && <details className="hardware-build-log"><summary>Toolchain output</summary><pre>{state.log}</pre></details>}{canExport && <p className="muted">The ZIP includes controller and application source, compiled firmware, dependency configuration, component and pin lists, wiring documentation, build instructions, and upload/run instructions.</p>}
            {canUpload && profile.uploadSupported && <details className="hardware-upload"><summary>Upload to a selected device</summary><p>Select the connected board, then request an upload. Compiling and downloading never flash a device.</p><button type="button" disabled={locked} onClick={findDevices}>Refresh connected devices</button><div className="hardware-upload-controls"><label>Device to upload to<select value={port} disabled={locked} onChange={event => setPort(event.target.value)}><option value="">Select a connected {profile.name}</option>{uploadDevices.map(device => <option key={device.port} value={device.port}>{device.label} · {device.port}{!device.identified ? ' · unidentified — verify selected board model' : ''}</option>)}</select></label><button type="button" disabled={locked || !port || !uploadDevices.some(device => device.port === port)} onClick={upload}>Upload firmware to selected device</button></div>{port && uploadDevices.some(device => device.port === port && !device.identified) && <p className="hardware-notice">This port did not identify its board. Verify that the connected device is {profile.name} ({profile.fqbn}) before requesting upload.</p>}{devices && uploadDevices.length === 0 && <p className="muted">No connected device was identified as this board. Confirm the board package and USB connection, then refresh.</p>}{state?.upload && <p className="hardware-notice">{state.upload.statement} Port: {state.upload.port}. Uploading does not verify physical behavior.</p>}</details>}
            {canExport && !profile.uploadSupported && <p className="muted">In-app upload is unavailable for this target. Use the run or upload instructions included in the ZIP.</p>}
          </section>
        </>}
        {(pending || building) && <p className="hardware-pending" role="status">{pending || 'The toolchain is compiling and checking this project. This may take a few minutes.'}</p>}
        {notice && <p className="hardware-notice" role="status">{notice}</p>}
        {error && <p className="hardware-error" role="alert">{error}</p>}
      </>}
    </div>}
  </section>;
}
