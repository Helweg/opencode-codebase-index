export type HostMode = "opencode" | "codex";

export const HOST_MODES: ReadonlyArray<HostMode> = ["opencode", "codex"];

export function parseHostMode(value: string | undefined): HostMode {
  const normalized = (value ?? "").toLowerCase();

  if (normalized === "opencode" || normalized === "codex") {
    return normalized;
  }

  throw new Error(`Invalid host mode: ${value ?? "(none)"}. Allowed values: opencode, codex.`);
}

export function isSupportedHostMode(value: string): value is HostMode {
  return value === "opencode" || value === "codex";
}
