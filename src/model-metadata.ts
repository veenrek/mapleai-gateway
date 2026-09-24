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
};
