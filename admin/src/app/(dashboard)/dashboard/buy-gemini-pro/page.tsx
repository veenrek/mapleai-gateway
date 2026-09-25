import type { Metadata } from "next";
import BuyGeminiClient from "./BuyGeminiClient";

export const metadata: Metadata = {
  title: "MapleAI — Buy Gemini Pro AI 18 Months",
  description: "Gemini Pro AI 18-Month subscription — instant delivery, pay by card via Lava.top",
};

export default function BuyGeminiProPage() {
  return <BuyGeminiClient />;
}
