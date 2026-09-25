/**
 * Relay Pool — Anthropic ↔ OpenAI converters.
 *
 * Ported from anthropic-api-relay `lib/anthropicOpenAI/{request,response,stream}.js`.
 * The relay-pool provider receives Claude-format bodies (chatCore translates the
 * client request before dispatch); these helpers convert to/from OpenAI-format
 * upstream accounts and convert their responses back to Claude format.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// ─── Request conversion: Anthropic body → OpenAI body ───────────────────────

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => blockToText(block))
    .filter((s) => s !== "")
    .join("\n\n");
}

// Render each Anthropic content block as plain text. We keep tool calls and
// their results readable so a chat model still sees the full conversation
// context (otherwise multi-turn agentic dialogs collapse into "[block omitted]").
function blockToText(block: unknown): string {
  const b = asRecord(block);
  if (!b) return "";
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? b.text : "";
    case "tool_use":
      return [
        `[Calling tool: ${typeof b.name === "string" ? b.name : "tool"}]`,
        "```json",
        JSON.stringify(b.input ?? {}, null, 2),
        "```",
      ].join("\n");
    case "tool_result": {
      const inner = textFromContent(b.content);
      const head = `[Tool result${b.is_error ? " (error)" : ""}]`;
      return inner ? `${head}\n${inner}` : head;
    }
    case "image":
      return "[image omitted]";
    case "thinking":
      return ""; // drop intermediate reasoning; not relevant to the chat model
    default:
      return "";
  }
}

function systemToText(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textFromContent(system);
  return String(system);
}

// Fingerprints Claude Code prepends to its system prompt. They are useless to
// an OpenAI-format upstream and only identify the client, so they are dropped
// during the Anthropic->OpenAI conversion (the rest of the prompt is kept).
const SYSTEM_PROMPT_SIGNATURES = [
  /^\s*x-anthropic-billing-header:.*$/gim,
  /^\s*You are Claude Code, Anthropic's official CLI for Claude\.?\s*$/gim,
];

function sanitizeSystemText(text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const re of SYSTEM_PROMPT_SIGNATURES) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

interface ConverterAccount {
  model?: string | null;
  maxMessages?: number;
  maxTokens?: number;
}

function blockToToolCall(block: unknown): JsonRecord {
  const b = asRecord(block) ?? {};
  return {
    id: typeof b.id === "string" && b.id ? b.id : `call_${Date.now()}`,
    type: "function",
    function: {
      name: typeof b.name === "string" && b.name ? b.name : "tool",
      arguments: JSON.stringify(b.input ?? {}),
    },
  };
}

function toolResultToText(block: JsonRecord): string {
  if (typeof block.content === "string") return block.content;
  return textFromContent(block.content);
}

function convertAnthropicMessage(msg: unknown): JsonRecord[] {
  const m = asRecord(msg) ?? {};
  const rawContent = Array.isArray(m.content)
    ? m.content
    : [{ type: "text", text: String(m.content ?? "") }];
  const content = rawContent.map((c) => asRecord(c) ?? { type: "text", text: "" });
  const toolResults = content.filter((block) => block?.type === "tool_result");
  if (toolResults.length) {
    return toolResults.map((block) => ({
      role: "tool",
      tool_call_id:
        (typeof block.tool_use_id === "string" && block.tool_use_id) ||
        (typeof block.id === "string" && block.id) ||
        "unknown_tool_call",
      content: toolResultToText(block),
    }));
  }

  if (m.role === "assistant") {
    const toolUses = content.filter((block) => block?.type === "tool_use");
    const text = content
      .filter((block) => block?.type !== "tool_use")
      .map(blockToText)
      .filter(Boolean)
      .join("\n\n");
    if (toolUses.length) {
      return [
        {
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(blockToToolCall),
        },
      ];
    }
    return [{ role: "assistant", content: text }];
  }

  return [{ role: "user", content: textFromContent(rawContent) }];
}

function messageToSummaryLine(message: JsonRecord, index: number): string {
  if (!message) return "";
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    const names = message.tool_calls
      .map((call) => {
        const fn = asRecord(asRecord(call)?.function);
        return (fn?.name as string) || "tool";
      })
      .join(", ");
    const text = message.content ? `: ${String(message.content).slice(0, 1200)}` : "";
    return `${index}. assistant called tool(s): ${names}${text}`;
  }
  if (message.role === "tool") {
    return `${index}. tool result ${message.tool_call_id || ""}: ${String(message.content || "").slice(0, 1600)}`;
  }
  return `${index}. ${message.role}: ${String(message.content || "").slice(0, 1800)}`;
}

function assistantToolIds(message: JsonRecord): string[] {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call) => asRecord(call)?.id).filter(Boolean) as string[];
}

function toolAliasIds(id: string | undefined | null): string[] {
  if (!id) return [];
  return [id, id.startsWith("fc_") ? id.slice(3) : `fc_${id}`];
}

function assistantHasToolId(message: JsonRecord, id: string): boolean {
  const wanted = new Set(toolAliasIds(id));
  return assistantToolIds(message).some(
    (callId) => wanted.has(callId) || toolAliasIds(callId).includes(id)
  );
}

function findToolAwareTailStart(
  messages: JsonRecord[],
  minStart: number,
  desiredStart: number
): number {
  let tailStart = Math.max(minStart, desiredStart);

  while (tailStart > minStart) {
    const known = new Set<string>();
    for (let i = tailStart; i < messages.length; i += 1) {
      for (const id of assistantToolIds(messages[i])) {
        for (const alias of toolAliasIds(id)) known.add(alias);
      }
    }

    const missingTool = messages
      .slice(tailStart)
      .find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id &&
          !known.has(String(message.tool_call_id))
      );
    if (!missingTool) break;

    let foundAt = -1;
    for (let i = tailStart - 1; i >= minStart; i -= 1) {
      if (assistantHasToolId(messages[i], String(missingTool.tool_call_id))) {
        foundAt = i;
        break;
      }
    }
    if (foundAt < 0) break;
    tailStart = foundAt;
  }

  return tailStart;
}

function trimMessagesToolAware(messages: JsonRecord[], maxMessages: number): JsonRecord[] {
  if (!maxMessages || messages.length <= maxMessages) return messages;
  const firstSystem = messages[0]?.role === "system" ? messages[0] : null;
  const prefixCount = firstSystem ? 1 : 0;
  const desiredStart = Math.max(
    prefixCount,
    messages.length - Math.max(1, maxMessages - prefixCount)
  );
  const tailStart = findToolAwareTailStart(messages, prefixCount, desiredStart);
  return [firstSystem, ...messages.slice(tailStart)].filter(Boolean) as JsonRecord[];
}

function repairToolMessages(messages: JsonRecord[]): JsonRecord[] {
  const aliases = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const c = asRecord(call);
        if (!c?.id || typeof c.id !== "string") continue;
        aliases.set(c.id, c.id);
        aliases.set(c.id.startsWith("fc_") ? c.id.slice(3) : `fc_${c.id}`, c.id);
      }
    }
  }

  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    const realId = aliases.get(id);
    if (realId) {
      return realId === id ? message : { ...message, tool_call_id: realId };
    }
    // Orphan tool result — rewrite as user text so strict upstreams accept it.
    return {
      role: "user",
      content: `[Tool result for missing call ${id}]\n${message.content || ""}`,
    };
  });
}

function convertTools(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    const t = asRecord(tool) ?? {};
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    };
  });
}

export function anthropicToOpenAI(body: unknown, account: ConverterAccount = {}): JsonRecord {
  const b = asRecord(body) ?? {};
  const messages: JsonRecord[] = [];
  const system = sanitizeSystemText(systemToText(b.system));
  const relayToolInstruction = [
    "Relay compatibility note for tool use:",
    "- Do not invent file paths. Prefer Glob/Grep/List before Read when unsure.",
    '- For Read, omit optional pages unless you need a valid range like "1" or "1-5"; never send pages:"".',
    "- Omit optional tool parameters when unknown instead of sending empty strings.",
    "- If a tool returns File does not exist, search for the correct path before retrying.",
  ].join("\n");
  if (system) messages.push({ role: "system", content: `${system}\n\n${relayToolInstruction}` });
  else messages.push({ role: "system", content: relayToolInstruction });

  for (const msg of (Array.isArray(b.messages) ? b.messages : []) as unknown[]) {
    messages.push(...convertAnthropicMessage(msg));
  }

  const maxMessages = Number(account.maxMessages || process.env.OPENAI_MAX_MESSAGES || 0);
  const trimmedMessages = maxMessages > 0 ? trimMessagesToolAware(messages, maxMessages) : messages;
  const repairedMessages = repairToolMessages(trimmedMessages);

  const maxTokens = Number(account.maxTokens || process.env.OPENAI_MAX_TOKENS || 4096);

  const out: JsonRecord = {
    model:
      account.model ||
      process.env.OPENAI_MODEL ||
      (typeof b.model === "string" ? b.model : undefined),
    messages: repairedMessages,
    stream: Boolean(b.stream),
    max_tokens: Math.min(Number(b.max_tokens || maxTokens), maxTokens),
    temperature: b.temperature,
    top_p: b.top_p,
    stop: b.stop_sequences,
  };

  const tools = convertTools(b.tools);
  if (tools?.length) out.tools = tools;

  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// ─── Non-streaming response conversion: OpenAI JSON → Anthropic JSON ────────

function safeJson(value: unknown): JsonRecord {
  try {
    const parsed = JSON.parse((value as string) || "{}");
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function sanitizeToolInput(input: unknown, toolName = ""): JsonRecord {
  const source = asRecord(input);
  if (!source) return {};
  const out: JsonRecord = { ...source };
  const name = String(toolName || "").toLowerCase();

  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string") out[key] = value.trim();
  }
  for (const key of ["pages", "type", "glob"]) {
    if (out[key] === "") delete out[key];
  }
  if (name === "read" && typeof out.pages === "string" && !/^\d+(?:-\d+)?$/.test(out.pages)) {
    delete out.pages;
  }
  for (const key of ["limit", "offset", "head_limit", "timeout"]) {
    if (out[key] === "" || out[key] === null) delete out[key];
  }
  if (name === "enterworktree") {
    if (out.name === "") delete out.name;
    if (out.path === "") delete out.path;
    if (out.name && out.path) delete out.name;
  }
  return out;
}

export function openAIToAnthropicResponse(data: unknown, model = ""): JsonRecord {
  const d = asRecord(data) ?? {};
  const choices = Array.isArray(d.choices) ? d.choices : [];
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const content: JsonRecord[] = [];

  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []) as unknown[]) {
    const c = asRecord(call) ?? {};
    const fn = asRecord(c.function) ?? {};
    content.push({
      type: "tool_use",
      id: c.id,
      name: (fn.name as string) || "tool",
      input: sanitizeToolInput(safeJson(fn.arguments), (fn.name as string) || "tool"),
    });
  }

  const usage = asRecord(d.usage) ?? {};
  return {
    id: d.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || d.model || "",
    content,
    stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// ─── Streaming conversion: OpenAI SSE → Anthropic SSE ───────────────────────

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function addToolDelta(toolCalls: (ToolCallAccumulator | undefined)[], deltas: unknown[]): void {
  for (const raw of deltas) {
    const delta = asRecord(raw);
    if (!delta) continue;
    const i = Number(delta.index) || 0;
    if (!toolCalls[i]) {
      toolCalls[i] = { id: (delta.id as string) || `toolu_${Date.now()}_${i}`, name: "", args: "" };
    }
    const acc = toolCalls[i]!;
    if (delta.id) acc.id = String(delta.id);
    const fn = asRecord(delta.function);
    if (fn?.name) acc.name += String(fn.name);
    if (fn?.arguments) acc.args += String(fn.arguments);
  }
}

function toolArgsJson(args: string, toolName = ""): string {
  return JSON.stringify(sanitizeToolInput(safeJson(args), toolName));
}

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert an OpenAI-format SSE upstream response into a Claude-format SSE Response.
 * Mirrors the relay's `pipeOpenAIStreamAsAnthropic`, but emits into a Web
 * ReadableStream instead of an Express response object.
 */
export function openAIStreamAsAnthropicResponse(
  upstreamResponse: Response,
  model = "",
  onUsage?: (usage: StreamUsage) => void
): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const streamed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      let closed = false;
      const safeWrite = (chunk: string) => {
        if (closed) return;
        try {
          write(chunk);
        } catch {
          closed = true;
        }
      };

      let buffer = "";
      let blockStarted = false;
      let index = 0;
      const toolCalls: (ToolCallAccumulator | undefined)[] = [];
      let aggregatedUsage: StreamUsage | null = null;

      const emitTextDelta = (text: string) => {
        if (!text) return;
        if (!blockStarted) {
          safeWrite(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            })
          );
          blockStarted = true;
        }
        safeWrite(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text },
          })
        );
      };

      try {
        safeWrite(
          sseEvent("message_start", {
            type: "message_start",
            message: {
              id: `msg_${Date.now()}`,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        );

        const reader = upstreamResponse.body!.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;

            let json: JsonRecord;
            try {
              json = asRecord(JSON.parse(payload)) ?? {};
            } catch {
              continue;
            }

            const usage = asRecord(json.usage);
            if (
              usage &&
              (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)
            ) {
              aggregatedUsage = {
                input_tokens: Number(usage.prompt_tokens) || 0,
                output_tokens: Number(usage.completion_tokens) || 0,
              };
            }

            if (json.error) {
              const errObj = asRecord(json.error);
              const message = (errObj?.message as string) || JSON.stringify(json.error);
              emitTextDelta(`OpenAI upstream error: ${message}`);
              continue;
            }

            const choices = Array.isArray(json.choices) ? json.choices : [];
            const delta = asRecord(asRecord(choices[0])?.delta) ?? {};
            if (Array.isArray(delta.tool_calls)) addToolDelta(toolCalls, delta.tool_calls);
            emitTextDelta(typeof delta.content === "string" ? delta.content : "");
          }
        }
      } catch (error) {
        console.error(
          "[relay-pool] openai stream read error:",
          error instanceof Error ? error.message : error
        );
        if (!blockStarted && !toolCalls.filter(Boolean).length) {
          emitTextDelta("OpenAI upstream stream ended early; retry the request if needed.");
        }
      }

      if (blockStarted) {
        safeWrite(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        index += 1;
      }

      for (const call of toolCalls.filter(Boolean) as ToolCallAccumulator[]) {
        const partialJson = toolArgsJson(call.args, call.name || "tool");
        safeWrite(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: call.id, name: call.name || "tool", input: {} },
          })
        );
        safeWrite(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: partialJson },
          })
        );
        safeWrite(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        index += 1;
      }

      const stopReason = toolCalls.filter(Boolean).length ? "tool_use" : "end_turn";
      safeWrite(
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: aggregatedUsage?.output_tokens ?? 0 },
        })
      );
      safeWrite(sseEvent("message_stop", { type: "message_stop" }));

      if (onUsage && aggregatedUsage) {
        try {
          onUsage(aggregatedUsage);
        } catch {}
      }
      controller.close();
    },
  });

  return new Response(streamed, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
