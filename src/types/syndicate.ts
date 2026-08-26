export type SyndicateScope =
  | "machine.read"
  | "workspace.read"
  | "workspace.create"
  | "session.start"
  | "terminal.view"
  | "terminal.input"
  | "terminal.resize"
  | "terminal.stop";

export type SyndicateGrantStatus = "pending" | "active" | "revoked" | "expired";
export type SyndicateTransport = "packet-relay" | "ssh-forward";

/** Persisted metadata only. Device private keys live in the OS keychain. */
export interface SyndicateMachine {
  machineId: string;
  displayName: string;
  deviceId: string;
  serverConfigId: string;
  localPort: number;
  /** Narrow PacketRelay product-route WSS endpoint; controller paths remain fixed native-side. */
  relayEndpoint?: string;
  hostFingerprint?: string;
  machineSigningFingerprint: string;
  machineKeyAgreementFingerprint?: string;
  grantStatus: SyndicateGrantStatus;
  /** Known v1 scopes plus any future scope strings retained for honest UI. */
  scopes: string[];
  addedAt: number;
  lastConnectedAt?: number;
  /**
   * Epoch milliseconds at which the Host stops honouring this grant, from the
   * relay grant in `machine.snapshot`. Grants last 30 days and have no renewal
   * path, so without this the UI cannot warn before the cliff — it can only
   * report the failure afterwards. Undefined when the Host has issued no relay
   * grant, which is the case for SSH-only pairings.
   */
  grantExpiresAt?: number;
  cachedSnapshot?: SyndicateMachineSnapshot;
}

export interface SyndicateAgentSnapshot {
  profileId: "codex" | "claude" | "packetcode";
  displayName: string;
  version?: string;
  state: "ready" | "auth-required" | "unavailable" | "unsupported";
}

export interface SyndicateMachineSnapshot {
  machine: {
    machineId: string;
    displayName: string;
    os: string;
    architecture: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  controller: {
    protocolVersion: 1;
    /** Host-reported local controller transport. PacketBench may carry these
     * signed requests through PacketRelay or its pinned SSH forward. */
    transport: "ssh-forward";
    device: {
      deviceId: string;
      scopes: string[];
      revocationEpoch: number;
      /**
       * Host-signed PacketRelay grant. Only `expiresAt` is read here — the
       * certificate itself is verified and stored natively and never crosses
       * into the frontend as authority.
       */
      relayGrant?: { grant?: { expiresAt?: string } };
    };
  };
  agents: SyndicateAgentSnapshot[];
  snapshotSequence: number;
}

export interface SyndicateWorkspaceSnapshot {
  workspaceId: string;
  displayName: string;
  repositoryId?: string;
  repositoryName?: string;
  displayPath?: string;
  state?: string;
}

export interface SyndicateRepositorySnapshot {
  repositoryId: string;
  displayName: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SyndicateWorkspaceCatalog {
  repositories: SyndicateRepositorySnapshot[];
  workspaces: SyndicateWorkspaceSnapshot[];
  snapshotSequence: number;
}

export interface SyndicateReplayResult {
  chunks: Array<{ sequence: number; dataBase64: string }>;
  oldestAvailableSequence: number;
  latestSequence: number;
  nextAfterSequence: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface SyndicateSessionResult {
  session: { sessionId: string; state?: string };
  replay?: SyndicateReplayResult;
}

export function parseSessionResult(value: unknown): SyndicateSessionResult {
  if (!value || typeof value !== "object") throw new Error("Invalid Syndicate session response");
  const object = value as Record<string, unknown>;
  if (!object.session || typeof object.session !== "object") {
    throw new Error("Invalid Syndicate session identity");
  }
  const rawSession = object.session as Record<string, unknown>;
  if (typeof rawSession.sessionId !== "string") {
    throw new Error("Syndicate response is missing a session id");
  }
  let replay: SyndicateReplayResult | undefined;
  if (object.replay !== undefined) {
    if (!object.replay || typeof object.replay !== "object") {
      throw new Error("Invalid Syndicate replay response");
    }
    const raw = object.replay as Record<string, unknown>;
    if (
      !Array.isArray(raw.chunks) ||
      !raw.chunks.every(
        (chunk) =>
          !!chunk &&
          typeof chunk === "object" &&
          Number.isSafeInteger((chunk as Record<string, unknown>).sequence) &&
          typeof (chunk as Record<string, unknown>).dataBase64 === "string",
      ) ||
      !Number.isSafeInteger(raw.oldestAvailableSequence) ||
      !Number.isSafeInteger(raw.latestSequence) ||
      !Number.isSafeInteger(raw.nextAfterSequence) ||
      typeof raw.hasMore !== "boolean" ||
      typeof raw.truncated !== "boolean"
    ) {
      throw new Error("Syndicate returned an incompatible replay response");
    }
    replay = raw as unknown as SyndicateReplayResult;
  }
  return {
    session: {
      sessionId: rawSession.sessionId,
      state: typeof rawSession.state === "string" ? rawSession.state : undefined,
    },
    replay,
  };
}

export interface SyndicateMachineConnection {
  machineId: string;
  deviceId: string;
  serverConfigId: string;
  localPort: number;
  relayEndpoint?: string;
}

export interface SyndicateRpcResult<T = unknown> {
  requestId: string;
  result: T;
  /** PacketBench's selected carrier for this successful request. */
  transport: SyndicateTransport;
}

export interface SyndicatePairResult {
  machineId: string;
  machineName: string;
  deviceId: string;
  serverConfigId: string;
  localPort: number;
  relayEndpoint?: string;
  hostFingerprint?: string;
  machineSigningFingerprint: string;
  machineKeyAgreementFingerprint?: string;
  grantStatus: SyndicateGrantStatus;
  scopes: string[];
}

export function pairingPackageRelayEndpoint(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const endpoint = (value as Record<string, unknown>).relayEndpoint;
  return typeof endpoint === "string" && endpoint.trim() ? endpoint.trim() : undefined;
}

export function syndicateConnection(machine: SyndicateMachine): SyndicateMachineConnection {
  return {
    machineId: machine.machineId,
    deviceId: machine.deviceId,
    serverConfigId: machine.serverConfigId,
    localPort: machine.localPort,
    relayEndpoint: machine.relayEndpoint,
  };
}

export function parseMachineSnapshot(value: unknown): SyndicateMachineSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid Syndicate machine snapshot");
  const raw = value as Record<string, unknown>;
  const rawMachine = raw.machine as Record<string, unknown> | undefined;
  const platform = rawMachine?.platform as Record<string, unknown> | undefined;
  const controller = raw.controller as SyndicateMachineSnapshot["controller"] | undefined;
  const capabilities = raw.capabilities as Record<string, unknown> | undefined;
  const terminal = capabilities?.terminal as Record<string, unknown> | undefined;
  const launchProfiles = Array.isArray(terminal?.launchProfiles) ? terminal.launchProfiles : [];
  const agentProbes = Array.isArray(capabilities?.agents) ? capabilities.agents : [];
  const profileName = (profileId: string) =>
    profileId === "claude" ? "Claude Code" : profileId === "codex" ? "Codex CLI" : "PacketCode";
  const agents: SyndicateAgentSnapshot[] = launchProfiles.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const profile = value as Record<string, unknown>;
    if (!["codex", "claude", "packetcode"].includes(String(profile.id))) return [];
    const probe = agentProbes.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).id === profile.id,
    ) as Record<string, unknown> | undefined;
    const authReady = probe?.auth === "authenticated" || probe?.auth === "not-applicable";
    return [
      {
        profileId: profile.id as SyndicateAgentSnapshot["profileId"],
        displayName:
          typeof probe?.displayName === "string"
            ? probe.displayName
            : profileName(String(profile.id)),
        version:
          typeof profile.version === "string"
            ? profile.version
            : typeof probe?.version === "string"
              ? probe.version
              : undefined,
        state: profile.available !== true ? "unavailable" : authReady ? "ready" : "auth-required",
      },
    ];
  });
  const snapshot: Partial<SyndicateMachineSnapshot> = {
    machine:
      rawMachine && platform
        ? {
            machineId: typeof rawMachine.id === "string" ? rawMachine.id : "",
            displayName:
              typeof rawMachine.displayName === "string" ? rawMachine.displayName : "Syndicate",
            os: typeof platform.os === "string" ? platform.os : "unknown",
            architecture:
              typeof platform.architecture === "string" ? platform.architecture : "unknown",
            logicalCpuCount:
              typeof platform.logicalCpuCount === "number" ? platform.logicalCpuCount : 0,
            totalMemoryBytes:
              typeof platform.totalMemoryBytes === "number" ? platform.totalMemoryBytes : 0,
          }
        : undefined,
    controller,
    agents,
    snapshotSequence: typeof raw.snapshotSequence === "number" ? raw.snapshotSequence : undefined,
  };
  if (
    !snapshot.machine ||
    typeof snapshot.machine.machineId !== "string" ||
    typeof snapshot.machine.displayName !== "string" ||
    typeof snapshot.machine.os !== "string" ||
    typeof snapshot.machine.architecture !== "string" ||
    typeof snapshot.machine.logicalCpuCount !== "number" ||
    typeof snapshot.machine.totalMemoryBytes !== "number" ||
    !snapshot.controller ||
    snapshot.controller.protocolVersion !== 1 ||
    !snapshot.controller.device ||
    !Array.isArray(snapshot.controller.device.scopes) ||
    !snapshot.controller.device.scopes.every((scope) => typeof scope === "string") ||
    !Array.isArray(snapshot.agents) ||
    typeof snapshot.snapshotSequence !== "number"
  ) {
    throw new Error("Syndicate returned an incompatible machine snapshot");
  }
  return snapshot as SyndicateMachineSnapshot;
}

/**
 * Epoch milliseconds at which this snapshot's relay grant expires.
 *
 * Grants are issued for 30 days with no renewal path, and the Host puts
 * `expiresAt` inside the relay grant it returns from `machine.snapshot`. A
 * snapshot with no relay grant (SSH-only pairings) yields undefined rather
 * than a guess.
 */
export function grantExpiryFromSnapshot(snapshot: SyndicateMachineSnapshot): number | undefined {
  const expiresAt = snapshot.controller.device.relayGrant?.grant?.expiresAt;
  if (typeof expiresAt !== "string") return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseWorkspaceCatalog(value: unknown): SyndicateWorkspaceCatalog {
  if (!value || typeof value !== "object") throw new Error("Invalid Syndicate workspace list");
  const object = value as Record<string, unknown>;
  const workspaces = object.workspaces;
  const repositories = object.repositories;
  if (!Array.isArray(workspaces)) throw new Error("Syndicate workspace list is missing workspaces");
  if (!Array.isArray(repositories)) {
    throw new Error("Syndicate workspace list is missing repositories");
  }
  const parsedWorkspaces = workspaces.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid Syndicate workspace");
    const raw = value as Record<string, unknown>;
    const workspaceId =
      typeof raw.workspaceId === "string"
        ? raw.workspaceId
        : typeof raw.id === "string"
          ? raw.id
          : null;
    const displayName =
      typeof raw.displayName === "string"
        ? raw.displayName
        : typeof raw.name === "string"
          ? raw.name
          : null;
    if (!workspaceId || !displayName) throw new Error("Syndicate workspace identity is missing");
    return {
      workspaceId,
      displayName,
      repositoryId: typeof raw.repositoryId === "string" ? raw.repositoryId : undefined,
      repositoryName: typeof raw.repositoryName === "string" ? raw.repositoryName : undefined,
      displayPath:
        typeof raw.displayPath === "string"
          ? raw.displayPath
          : typeof raw.repositoryPath === "string"
            ? raw.repositoryPath
            : undefined,
      state: typeof raw.state === "string" ? raw.state : undefined,
    };
  });
  const parsedRepositories = repositories.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid Syndicate repository");
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.repositoryId !== "string" ||
      typeof raw.displayName !== "string" ||
      typeof raw.state !== "string"
    ) {
      throw new Error("Syndicate repository identity is missing");
    }
    return {
      repositoryId: raw.repositoryId,
      displayName: raw.displayName,
      state: raw.state,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
  });
  if (!Number.isSafeInteger(object.snapshotSequence)) {
    throw new Error("Syndicate workspace list is missing its snapshot sequence");
  }
  return {
    repositories: parsedRepositories,
    workspaces: parsedWorkspaces,
    snapshotSequence: object.snapshotSequence as number,
  };
}

export function parseWorkspaceList(value: unknown): SyndicateWorkspaceSnapshot[] {
  return parseWorkspaceCatalog(value).workspaces;
}

export function parseWorkspaceCreate(value: unknown): SyndicateWorkspaceSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Syndicate workspace.create response");
  }
  const raw = (value as Record<string, unknown>).workspace;
  return parseWorkspaceCatalog({ repositories: [], workspaces: [raw], snapshotSequence: 0 })
    .workspaces[0];
}
