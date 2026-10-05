/**
 * OpenAI Responses API (alpha) <-> Chat Completions translation.
 *
 * The upstream provider speaks Chat Completions, so `/api/v1/responses` accepts
 * the Responses request shape, forwards an equivalent chat request, and maps the
 * answer back — including the `response.*` SSE event sequence when streaming.
 */

export interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

interface ResponsesContentPart {
  type?: string;
  text?: string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  output?: unknown;
  name?: string;
  arguments?: string;
}

export interface ResponsesRequestBody {
  model?: string;
  input?: unknown;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  text?: { format?: { type?: string } };
  [key: string]: unknown;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ResponsesContentPart[])
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .join("");
}

/** Responses `tools` are flat; chat `tools` nest under `function`. */
function toolsToChat(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .map((tool) => {
      const t = tool as Record<string, unknown>;
      if (t?.type !== "function") return undefined;
      if (t.function) return t;
      const { type, ...rest } = t;
      return { type, function: rest };
    })
    .filter((t) => t !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

/** Build the chat-completions request equivalent of a Responses request. */
export function toChatRequest(body: ResponsesRequestBody, upstreamModel: string): Record<string, unknown> {
  const messages: ChatMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input as ResponsesInputItem[]) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: raw.call_id ?? "",
          content: typeof raw.output === "string" ? raw.output : JSON.stringify(raw.output ?? ""),
        });
        continue;
      }
      const role = typeof raw.role === "string" ? raw.role : "user";
      const text = contentToText(raw.content);
      if (text.length > 0 || raw.content === "") messages.push({ role, content: text });
    }
  }

  const chat: Record<string, unknown> = { model: upstreamModel, messages };

  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (body.stream === true) chat.stream = true;

  const tools = toolsToChat(body.tools);
  if (tools) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  }

  const format = body.text?.format?.type;
  if (format === "json_object") chat.response_format = { type: "json_object" };

  return chat;
}

interface ChatChoiceMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

interface ChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{ message?: ChatChoiceMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

export interface ResponsesOutputItem {
  id: string;
  type: string;
  status: string;
  role?: string;
  content?: Array<{ type: string; text: string; annotations: unknown[] }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponsesObject {
  id: string;
  object: "response";
  created_at: number;
  status: string;
  model?: string;
  output: ResponsesOutputItem[];
  output_text: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  error?: unknown;
}

/** Convert a chat-completions payload into a Responses object. */
export function toResponsesObject(
  chat: ChatCompletionResponse,
  requestedModel: string | undefined,
): ResponsesObject {
  const message = chat.choices?.[0]?.message ?? {};
  const output: ResponsesOutputItem[] = [];

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0 || !message.tool_calls?.length) {
    output.push({
      id: randomId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  for (const call of message.tool_calls ?? []) {
    output.push({
      id: randomId("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.id ?? randomId("call"),
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    });
  }

  const usage = chat.usage
    ? {
        input_tokens: chat.usage.prompt_tokens ?? 0,
        output_tokens: chat.usage.completion_tokens ?? 0,
        total_tokens:
          chat.usage.total_tokens ??
          (chat.usage.prompt_tokens ?? 0) + (chat.usage.completion_tokens ?? 0),
      }
    : undefined;

  return {
    id: chat.id ? `resp_${chat.id}` : randomId("resp"),
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel ?? chat.model,
    output,
    output_text: text,
    usage,
  };
}

/** Render a Responses object as its `response.*` SSE event sequence. */
export function toResponsesSse(response: ResponsesObject): string {
  const events: string[] = [];
  const push = (type: string, payload: Record<string, unknown>) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const inProgress: ResponsesObject = { ...response, status: "in_progress", output: [], output_text: "" };
  push("response.created", { response: inProgress });
  push("response.in_progress", { response: inProgress });

  for (const [index, item] of response.output.entries()) {
    push("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } });

    if (item.type === "message" && item.content) {
      const text = item.content[0]?.text ?? "";
      push("response.content_part.added", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      if (text.length > 0) {
        push("response.output_text.delta", {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta: text,
        });
      }
      push("response.output_text.done", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text,
      });
      push("response.content_part.done", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
    }

    if (item.type === "function_call") {
      push("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: item.arguments ?? "",
      });
      push("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments ?? "",
      });
    }

    push("response.output_item.done", { output_index: index, item });
  }

  push("response.completed", { response });
  events.push("data: [DONE]\n\n");
  return events.join("");
}
