import os from "node:os";
import path from "node:path";

/**
 * NFT-safe home/AppData accessors.
 *
 * Building fs paths from `os.homedir()` or `process.env.APPDATA` makes Next.js
 * file tracing emit wildcard globs over the entire user profile tree. On
 * Windows those walks hit ACL-protected legacy junctions ("Application Data",
 * "Cookies") and fail the production build with EPERM. Reading the base path
 * through these runtime-only accessors keeps it opaque to static analysis.
 */

export function safeHomedir(): string {
  return process.env.OMNIROUTE_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** %APPDATA% (Roaming) — NFT-safe variant of process.env.APPDATA. */
export function safeAppData(): string {
  return process.env.APPDATA || path.join(safeHomedir(), "AppData", "Roaming");
}

/** %LOCALAPPDATA% — NFT-safe variant of process.env.LOCALAPPDATA. */
export function safeLocalAppData(): string {
  return process.env.LOCALAPPDATA || path.join(safeHomedir(), "AppData", "Local");
}
