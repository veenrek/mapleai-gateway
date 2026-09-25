/**
 * octra — minimal JSON tree builder behind the OmniRoute JSON viewer.
 *
 * Pure logic only (no React) so it can be unit-tested with the Node test
 * runner. The viewer component (src/shared/components/OctraJsonViewer.tsx)
 * owns rendering and collapse state.
 */

import type { JsonValue } from "../types/requestLog";

export type OctraNodeKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface OctraNode {
  /** Stable id derived from the JSON path (e.g. `$.items[2].name`). */
  id: string;
  /** Property key / array index label; `null` for the root. */
  key: string | null;
  kind: OctraNodeKind;
  depth: number;
  /** Primitive value (only for string/number/boolean/null kinds). */
  value?: string | number | boolean | null;
  /** Child count for object/array nodes. */
  size?: number;
  children?: OctraNode[];
}

export interface OctraParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const MAX_DEPTH = 64;
const MAX_CHILDREN = 1000;

function kindOf(value: unknown): OctraNodeKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

function escapePathKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
}

/**
 * Build a tree of {@link OctraNode}s from any JSON-ish value. Defensive
 * against circular references and pathological depth so arbitrary payloads
 * can never hang the UI.
 */
export function buildOctraTree(root: unknown): OctraNode {
  const seen = new WeakSet<object>();

  const build = (key: string | null, value: unknown, path: string, depth: number): OctraNode => {
    const kind = kindOf(value);
    const node: OctraNode = { id: path, key, kind, depth };

    if (kind === "object" || kind === "array") {
      if (depth >= MAX_DEPTH || seen.has(value as object)) {
        node.children = [];
        node.size = -1; // sentinel: truncated / circular
        return node;
      }
      seen.add(value as object);
      const entries =
        kind === "array"
          ? (value as unknown[]).map((v, i) => [String(i), v] as const)
          : Object.entries(value as Record<string, unknown>);
      node.size = entries.length;
      node.children = entries
        .slice(0, MAX_CHILDREN)
        .map(([k, v]) =>
          build(k, v, kind === "array" ? `${path}[${k}]` : `${path}.${escapePathKey(k)}`, depth + 1)
        );
      seen.delete(value as object);
      return node;
    }

    node.value = value as string | number | boolean | null;
    return node;
  };

  return build(null, root, "$", 0);
}

/** Display text for a primitive node (strings are quoted). */
export function formatOctraValue(node: OctraNode): string {
  if (node.kind === "string") return JSON.stringify(node.value);
  if (node.kind === "null") return "null";
  return String(node.value);
}

/** Short summary shown next to collapsed objects/arrays, e.g. `{3 keys}` / `[2]`. */
export function previewOctraNode(node: OctraNode): string {
  if (node.kind === "object") {
    if (node.size === -1) return "{…}";
    return node.size === 0 ? "{}" : `{${node.size === 1 ? "1 key" : `${node.size} keys`}}`;
  }
  if (node.kind === "array") {
    if (node.size === -1) return "[…]";
    return node.size === 0 ? "[]" : `[${node.size}]`;
  }
  return formatOctraValue(node);
}

/** Parse a JSON string without throwing; fails soft for the viewer fallback. */
export function parseJsonSafely(text: string): OctraParseResult {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
}

export type { JsonValue };
