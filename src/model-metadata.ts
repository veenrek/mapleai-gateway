// Extended model metadata for the /v1/models endpoint.
export interface ModelMetadata {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  description: string;
  context_window: number;
  max_output: number;
  categories: string[];
  pricing: { input: number; output: number };
}

const common = {
  object: "model" as const,
  created: 1700000000,
  owned_by: "openai",
  context_window: 1_050_000,
  max_output: 128_000,
};

export const MODEL_METADATA: Record<string, ModelMetadata> = {
  "openai/gpt-5.6-sol": { ...common, id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", description: "Flagship reasoning model for complex coding and long-horizon agentic work", categories: ["chat", "reasoning", "coding", "vision"], pricing: { input: 2.8, output: 14 } },
  "openai/gpt-5.6-terra": { ...common, id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", description: "Balanced model for everyday coding, reasoning and agentic tasks", categories: ["chat", "reasoning", "coding", "vision"], pricing: { input: 1.4, output: 8.4 } },
  "openai/gpt-6-luna": { ...common, id: "openai/gpt-6-luna", name: "GPT-6 Luna", description: "Cost-efficient model for high-volume, latency-sensitive workloads", categories: ["chat", "coding", "vision"], pricing: { input: 0.07, output: 0.35 } },
  "openai/gpt-6-sol": { ...common, id: "openai/gpt-6-sol", name: "GPT-6 Sol", description: "Balanced GPT-6 model for coding, reasoning and agentic tasks", categories: ["chat", "reasoning", "coding", "vision"], pricing: { input: 1.4, output: 7 } },
  "anthropic/claude-haiku-4-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fastest Claude — cheap high-volume agentic and chat workloads; Anthropic Messages API at /v1/messages", categories: ["chat", "coding"], pricing: { input: 0.5, output: 2.5 } },
  "anthropic/claude-sonnet-4-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", description: "Sonnet-line balanced coding and agentic performance; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 1.5, output: 7.5 } },
  "anthropic/claude-sonnet-4-6": { ...common, owned_by: "anthropic", id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "Sonnet-line balanced coding and agentic performance; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 1.5, output: 7.5 } },
  "anthropic/claude-sonnet-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", description: "Best balance of speed and intelligence — near-Opus coding and agentic performance; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 1, output: 5 } },
  "anthropic/claude-sonnet-5-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "Newest Sonnet — coding and agentic performance; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 1, output: 5 } },
  "anthropic/claude-opus-4-6": { ...common, owned_by: "anthropic", id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", description: "Opus-class deep reasoning and agentic coding; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 2.5, output: 12.5 } },
  "anthropic/claude-opus-4-7": { ...common, owned_by: "anthropic", id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", description: "Opus-class deep reasoning and agentic coding; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 2.5, output: 12.5 } },
  "anthropic/claude-opus-4-8": { ...common, owned_by: "anthropic", id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", description: "Opus-class deep reasoning and agentic coding; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 2.5, output: 12.5 } },
  "anthropic/claude-opus-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-opus-5", name: "Claude Opus 5", description: "Newest Opus — deep reasoning and agentic coding; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 2.5, output: 12.5 } },
  "anthropic/claude-opus-5-5": { ...common, owned_by: "anthropic", id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", description: "Top Claude tier — deep reasoning and agentic coding; Anthropic Messages API at /v1/messages", categories: ["chat", "coding", "reasoning", "vision"], pricing: { input: 2, output: 10 } },
};
