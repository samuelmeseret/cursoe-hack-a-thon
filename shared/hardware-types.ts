/** Serializable hardware contracts. Profiles are derived from installed toolchain metadata. */
export interface HardwarePin {
  id: string;
  label: string;
  digital: boolean;
  analog: boolean;
  pwm: boolean;
  /** Arduino pin number; A0 and its numeric alias identify the same physical pin. */
  number: number;
  interfaces: string[];
  reserved?: string;
}

export interface HardwareOption {
  id: string;
  label: string;
  values: { id: string; label: string; selected: boolean }[];
}

export interface HardwareProfile {
  id: string;
  name: string;
  fqbn: string;
  architecture: string;
  framework: string;
  toolchain: string;
  adapter: string;
  core: string;
  version: string;
  installed: boolean;
  pins: HardwarePin[];
  interfaces: string[];
  capabilities: string[];
  constraints: string[];
  supported: boolean;
  missingCapabilities: string[];
  uploadSupported: boolean;
  options: HardwareOption[];
  flashBytes?: number;
  ramBytes?: number;
  /** Known GPIO logic limit from architecture/variant data; absent when unknown. */
  logicVoltage?: number;
  /** Core and variant files which supplied the profile, suitable for provenance. */
  metadataSources: string[];
}

export type DeviceProfile = HardwareProfile;

export interface BoardCatalogEntry {
  id: string;
  name: string;
  /** Package indexes omit FQBNs until their board package is installed. */
  fqbn?: string;
  architecture: string;
  core: string;
  version: string;
  installed: boolean;
  supported: boolean;
  missingCapabilities: string[];
}

export interface BoardPackageEntry {
  id: string;
  name: string;
  architecture: string;
  version: string;
  installed: boolean;
  maintainer: string;
  boards: string[];
}

export interface HardwareCatalog {
  boards: BoardCatalogEntry[];
  packages: BoardPackageEntry[];
  warnings: string[];
}

export interface ConnectedDevice {
  port: string;
  label: string;
  protocol: string;
  boards: { name: string; fqbn: string }[];
  /** A serial port is not by itself proof that a supported board is attached. */
  identified: boolean;
}

export interface HardwareLibrary { name: string; version?: string }

export interface HardwareBuildArtifact { name: string; path: string; sha256: string; bytes: number }

export interface HardwareBuildResult {
  profile: HardwareProfile;
  log: string;
  artifacts: HardwareBuildArtifact[];
  dependencies: HardwareLibrary[];
  command: string[];
  compiledAt: string;
  /** Compiling or uploading never establishes physical behavior. */
  physicallyTested: false;
}
