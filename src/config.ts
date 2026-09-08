// .vaan/config/config.json — what the onboarding decided.
//
// The file is the source of truth and it is meant to be edited by hand; nothing
// in Vaan writes it except `vaan init` and `/settings`. Reading it is defensive
// to the point of paranoia: a hand-edited config with a typo in it should start
// Vaan with the default for that one field, not refuse to start at all. The one
// thing it can never do is widen `FLOOR` in src/permissions/rules.ts, which no
// config field reaches.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ALL_APPROVALS, type ApprovalFlags } from "./permissions/rules.js";
import { configDir, configFile } from "./paths.js";
import { DEFAULT_NETWORK_POLICY, type NetworkPolicy } from "./sandbox/network.js";
import { TOOL_GROUPS, type ToolGroup } from "./types.js";

export type SandboxProfileName = "restricted" | "standard" | "custom";

export interface SandboxProfile {
  name: SandboxProfileName;
  /** How long a single command may run before it's killed. */
  commandTimeoutMs: number;
  /** Whether tools may reach loopback and private addresses. */
  allowLocalNetwork: boolean;
  /** Re-ask for every command, even one approved a minute ago. */
  confirmEveryCommand: boolean;
}

export const SANDBOX_PROFILES: Record<"restricted" | "standard", SandboxProfile> = {
  restricted: {
    name: "restricted",
    commandTimeoutMs: 60_000,
    allowLocalNetwork: false,
    confirmEveryCommand: true,
  },
  standard: {
    name: "standard",
    commandTimeoutMs: 300_000,
    allowLocalNetwork: false,
    confirmEveryCommand: false,
  },
};

export interface Config {
  version: 1;
  /** Absolute path. Stored so `vaan trace` and friends agree on what "here" is. */
  workspace: string;
  /** `provider/model`. */
  model: string;
  agentName: string;
  memory: boolean;
  tools: ToolGroup[];
  sandbox: SandboxProfile;
  approvals: ApprovalFlags;
  network: NetworkPolicy;
}

export const DEFAULT_AGENT_NAME = "Vaan";

export function defaultConfig(workspace: string, model = ""): Config {
  return {
    version: 1,
    workspace,
    model,
    agentName: DEFAULT_AGENT_NAME,
    memory: true,
    // Browser and integrations ship no tools, so they're off by default rather
    // than on and empty.
    tools: ["files", "search", "git", "web", "code", "memory"],
    sandbox: SANDBOX_PROFILES.restricted,
    approvals: { ...ALL_APPROVALS },
    network: { ...DEFAULT_NETWORK_POLICY },
  };
}

export function saveConfig(workspace: string, config: Config): string {
  mkdirSync(configDir(workspace), { recursive: true });
  const path = configFile(workspace);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

/** The stored config, with every unreadable field replaced by its default. */
export function loadConfig(workspace: string): Config | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile(workspace), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return coerce(parsed as Record<string, unknown>, workspace);
}

function coerce(raw: Record<string, unknown>, workspace: string): Config {
  const base = defaultConfig(workspace);
  const sandbox = raw.sandbox as Partial<SandboxProfile> | undefined;
  const profile =
    sandbox?.name === "standard"
      ? SANDBOX_PROFILES.standard
      : sandbox?.name === "custom"
        ? {
            name: "custom" as const,
            commandTimeoutMs: number(sandbox.commandTimeoutMs, base.sandbox.commandTimeoutMs),
            allowLocalNetwork: boolean(sandbox.allowLocalNetwork, false),
            confirmEveryCommand: boolean(sandbox.confirmEveryCommand, true),
          }
        : SANDBOX_PROFILES.restricted;

  const approvals = raw.approvals as Partial<ApprovalFlags> | undefined;
  const network = raw.network as Partial<NetworkPolicy> | undefined;

  return {
    version: 1,
    // The workspace we were launched in wins over the one on disk: a project
    // that was copied elsewhere should still work.
    workspace,
    model: string(raw.model, base.model),
    agentName: string(raw.agentName, base.agentName) || base.agentName,
    memory: boolean(raw.memory, base.memory),
    tools: groups(raw.tools, base.tools),
    sandbox: profile,
    approvals: {
      destructive: boolean(approvals?.destructive, true),
      network: boolean(approvals?.network, true),
      credentials: boolean(approvals?.credentials, true),
      outside: boolean(approvals?.outside, true),
      system: boolean(approvals?.system, true),
    },
    network: {
      allow: strings(network?.allow),
      deny: strings(network?.deny),
      // The profile decides this; the field only exists so a custom profile
      // has somewhere to say so.
      allowLocal: profile.allowLocalNetwork,
    },
  };
}

const string = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const boolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function groups(value: unknown, fallback: ToolGroup[]): ToolGroup[] {
  if (!Array.isArray(value)) return fallback;
  const known = new Set<string>(TOOL_GROUPS);
  const picked = value.filter((item): item is ToolGroup => typeof item === "string" && known.has(item));
  return picked.length > 0 ? picked : fallback;
}

/** What `/status` and `vaan doctor` print. */
export function describeConfig(config: Config): string[] {
  return [
    `agent       ${config.agentName}`,
    `workspace   ${config.workspace}`,
    `model       ${config.model || "(not set)"}`,
    `memory      ${config.memory ? "on" : "off"}`,
    `tools       ${config.tools.join(", ") || "(none)"}`,
    `sandbox     ${config.sandbox.name}`,
    `approvals   ${Object.entries(config.approvals)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(", ") || "(none required)"}`,
  ];
}
