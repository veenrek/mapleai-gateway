import type { Metadata } from "next";
import PublicShell from "@/app/PublicShell";
import BuyGeminiClient from "./BuyGeminiClient";

export const metadata: Metadata = {
  title: "Gemini Pro AI — 18 Months | Instant delivery",
  description:
    "Gemini Pro AI 18-month subscription: Antigravity, 5 TB Drive, Veo 3, Nano Banana. Pay by Card (Apple Pay / Google Pay), PayPal or PIX.",
  alternates: { canonical: "/buy/gemini-pro" },
  robots: { index: true, follow: true },
};

export default function BuyGeminiProPage() {
  return (
    <PublicShell>
      <BuyGeminiClient />
    </PublicShell>
  );
}
