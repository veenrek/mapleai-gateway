"use client";

import { useMemo, useState } from "react";
import { Braces } from "lucide-react";
import {
  buildOctraTree,
  formatOctraValue,
  parseJsonSafely,
  previewOctraNode,
  type OctraNode,
  type OctraNodeKind,
} from "../octra/octra";

const KIND_COLOR: Record<OctraNodeKind, string> = {
  string: "text-green-700 dark:text-green-300",
  number: "text-amber-700 dark:text-amber-300",
  boolean: "text-purple-700 dark:text-purple-300",
  null: "text-gray-500 italic",
  object: "text-text-muted",
  array: "text-text-muted",
};

interface OctraJsonViewerProps {
  /** JSON text (already pretty or raw). Falls back to a <pre> block if unparseable. */
  json: string;
  /** Auto-expand this many levels below the root. Default 1. */
  defaultExpandedDepth?: number;
  maxHeight?: string;
  className?: string;
}

interface RowProps {
  node: OctraNode;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}

function Row({ node, collapsed, onToggle }: RowProps) {
  const isContainer = node.kind === "object" || node.kind === "array";
  const label = node.key !== null && (
    <span className="text-sky-700 dark:text-sky-300 mr-1">
      {node.kind === "array" ? node.key : `"${node.key}"`}:
    </span>
  );

  if (!isContainer) {
    return (
      <div className="ml-4 whitespace-pre-wrap break-all">
        <span className="inline-block w-4" />
        {label}
        <span className={KIND_COLOR[node.kind]}>{formatOctraValue(node)}</span>
      </div>
    );
  }

  const open = node.kind === "object" ? "{" : "[";
  const close = node.kind === "object" ? "}" : "]";

  if (node.size === -1) {
    return (
      <div className="ml-4">
        <span className="inline-block w-4" />
        {label}
        <span className={KIND_COLOR[node.kind]}>
          {open} …truncated… {close}
        </span>
      </div>
    );
  }

  const isCollapsed = collapsed.has(node.id);

  if (isCollapsed) {
    return (
      <div className="ml-4">
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          className="inline-flex items-center justify-center w-4 text-text-muted hover:text-text-main select-none"
          aria-label={`Expand ${node.id}`}
        >
          ▸
        </button>
        {label}
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          className="text-text-muted hover:text-text-main"
          title="Expand"
        >
          {open} {previewOctraNode(node)} {close}
        </button>
      </div>
    );
  }

  return (
    <div className="ml-4">
      <button
        type="button"
        onClick={() => onToggle(node.id)}
        className="inline-flex items-center justify-center w-4 text-text-muted hover:text-text-main select-none"
        aria-label={`Collapse ${node.id}`}
      >
        ▾
      </button>
      {label}
      <span className="text-text-muted">{open}</span>
      <div className="border-l border-black/10 dark:border-white/10">
        {(node.children ?? []).map((child) => (
          <Row key={child.id} node={child} collapsed={collapsed} onToggle={onToggle} />
        ))}
      </div>
      <span className="inline-block w-4" />
      <span className="text-text-muted">{close}</span>
    </div>
  );
}

/**
 * Collapsible JSON tree viewer for request/response payloads in the logs UI.
 * `json` is the already-fetched payload string; invalid JSON falls back to a
 * plain <pre> so nothing is ever hidden.
 */
export default function OctraJsonViewer({
  json,
  defaultExpandedDepth = 1,
  maxHeight = "420px",
  className = "",
}: OctraJsonViewerProps) {
  const parsed = useMemo(() => parseJsonSafely(json), [json]);
  const tree = useMemo(() => (parsed.ok ? buildOctraTree(parsed.value) : null), [parsed]);

  const initialCollapsed = useMemo(() => {
    if (!tree) return new Set<string>();
    const set = new Set<string>();
    const walk = (n: OctraNode) => {
      if ((n.kind === "object" || n.kind === "array") && n.depth >= defaultExpandedDepth) {
        set.add(n.id);
        return; // children of a collapsed node are hidden anyway
      }
      n.children?.forEach(walk);
    };
    walk(tree);
    return set;
  }, [tree, defaultExpandedDepth]);

  const [collapsed, setCollapsed] = useState<Set<string>>(initialCollapsed);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!tree) {
    return (
      <pre
        className={`p-3 bg-black/5 dark:bg-white/5 rounded overflow-x-auto whitespace-pre-wrap break-all ${className}`}
      >
        {json}
      </pre>
    );
  }

  return (
    <div
      className={`flex items-start gap-2 font-mono text-[11px] bg-black/5 dark:bg-white/5 rounded p-3 overflow-auto ${className}`}
      style={{ maxHeight }}
    >
      <div className="flex-1 min-w-0">
        <Row node={tree} collapsed={collapsed} onToggle={toggle} />
      </div>
      <div className="shrink-0 self-start text-text-muted" title="JSON payload">
        <Braces size={13} />
      </div>
    </div>
  );
}
