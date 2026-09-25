import type { Metadata } from "next";
import CheckKeyClient from "./CheckKeyClient";

export const metadata: Metadata = {
  title: "API Key Checker — prepaid GPT-5.6 balance",
  description:
    "Instantly check the remaining token balance and status of your prepaid AI API key.",
  alternates: { canonical: "/check" },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "MapleAI",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description:
    "Prepaid OpenAI-compatible AI API. Buy a token pack, get one key for Codex CLI, OpenCode, VS Code or Hermes.",
  offers: {
    "@type": "Offer",
    category: "PayPerCall",
  },
};

export default function CheckKeyPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <CheckKeyClient />
    </>
  );
}
