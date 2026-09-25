/**
 * Cursor IDE installation detection.
 * Purely filesystem-based — no shell interpolation (Hard Rule #13).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectionResult } from "../types";
import { safeHomedir, safeLocalAppData } from "@/shared/utils/safeHomedir";

const HOME = os.homedir();
const PATHS = [
  "/Applications/Cursor.app",
  path.join(HOME, "Applications", "Cursor.app"),
  "/usr/bin/cursor",
  "/usr/local/bin/cursor",
  path.join(HOME, ".local", "bin", "cursor"),
  path.join(HOME, ".cursor"),
  path.join(safeLocalAppData(), "Programs", "cursor", "Cursor.exe"),
];

export function detectCursor(): DetectionResult {
  for (const p of PATHS) {
    if (fs.existsSync(p)) return { installed: true, path: p };
  }
  return { installed: false };
}
