const ENV_REFERENCE_PATTERN = /^\{env:([A-Z_][A-Z0-9_]*)\}$/;
const ENV_REFERENCE_LIKE_PATTERN = /\{env:[^}]+\}/;

export function substituteEnvString(value: string, keyPath: string): string {
  const match = value.match(ENV_REFERENCE_PATTERN);

  if (!match) {
    if (ENV_REFERENCE_LIKE_PATTERN.test(value)) {
      throw new Error(
        `Invalid environment variable reference at '${keyPath}'. ` +
        "Expected the entire string to match '{env:VAR_NAME}' with VAR_NAME matching [A-Z_][A-Z0-9_]*."
      );
    }

    return value;
  }

  const variableName = match[1];
  const envValue = process.env[variableName];

  if (envValue === undefined) {
    throw new Error(`Missing environment variable '${variableName}' referenced by config at '${keyPath}'.`);
  }

  return envValue;
}

export function substituteEnvReferences(raw: unknown, keyPath = "$root"): unknown {
  if (typeof raw === "string") {
    return substituteEnvString(raw, keyPath);
  }

  if (Array.isArray(raw)) {
    return raw.map((item, index) => substituteEnvReferences(item, `${keyPath}[${index}]`));
  }

  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, substituteEnvReferences(value, `${keyPath}.${key}`)])
    );
  }

  return raw;
}
