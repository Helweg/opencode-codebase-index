/**
 * URL validation utilities to prevent SSRF attacks against cloud metadata services.
 *
 * IMPORTANT: This intentionally allows localhost and private IPs because the custom
 * embedding provider is commonly used with local servers (Ollama, llama.cpp, vLLM,
 * text-embeddings-inference). The threat model is a malicious committed config file
 * targeting cloud metadata endpoints, not blocking legitimate local usage.
 *
 * KNOWN LIMITATION: This validates the hostname string only, not the resolved IP.
 * A DNS rebinding attack (hostname that resolves to 169.254.169.254) bypasses this
 * check. Full mitigation would require DNS resolution pinning (resolve → check IP →
 * connect), which needs a custom HTTP agent. Acceptable for now given the local-only
 * threat model and the low likelihood of DNS rebinding in committed config files.
 */

/** Cloud metadata service IPs and hostnames that should never be contacted. */
const BLOCKED_METADATA_IPS = [
  /^169\.254\.169\.254$/, // AWS/Azure/GCP metadata
  /^169\.254\.170\.2$/, // AWS ECS task metadata
  /^fd00:ec2::254$/, // AWS IMDSv2 IPv6
];

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.google",
  "metadata.goog",
  "kubernetes.default.svc",
]);

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that a URL does not point to cloud metadata services or use dangerous protocols.
 * Allows localhost and private IPs for local embedding servers.
 * Returns { valid: true } if the URL is safe, or { valid: false, reason } if blocked.
 */
export function validateExternalUrl(urlString: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: `Invalid URL: ${sanitizeUrlForError(urlString)}` };
  }

  // Block non-HTTP protocols (file://, gopher://, ftp://, etc.)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known cloud metadata hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: `Blocked: cloud metadata service (${hostname})` };
  }

  // Block cloud metadata IPs
  for (const pattern of BLOCKED_METADATA_IPS) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: `Blocked: cloud metadata IP (${hostname})` };
    }
  }

  // Block link-local range (169.254.x.x) — used exclusively for metadata/APIPA, not user servers
  if (/^169\.254\./.test(hostname)) {
    return { valid: false, reason: `Blocked: link-local address (${hostname})` };
  }

  return { valid: true };
}

/**
 * Strips credentials and sensitive parts from a URL for safe inclusion in error messages.
 */
export function sanitizeUrlForError(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove username:password from URL
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // If URL can't be parsed, truncate and mask
    const maxLen = 80;
    if (url.length > maxLen) {
      return url.slice(0, maxLen) + "...";
    }
    return url;
  }
}
