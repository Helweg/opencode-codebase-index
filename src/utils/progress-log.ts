import { appendFileSync } from "fs";

/**
 * Appends a timestamped progress line to the configured log file.
 * Errors are silently swallowed — this is best-effort monitoring output.
 */
export function writeProgressLog(filePath: string, message: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(filePath, `[${ts}] ${message}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}
