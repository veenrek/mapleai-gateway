import type { Metadata } from "next";
import CheckKeyClient from "./check/CheckKeyClient";

export const metadata: Metadata = {
  title: "MapleAI — Check prepaid key",
  description: "Check the balance and status of a prepaid API key",
};

// Главная страница временно показывает чек-ключ (витрина отключена).
export default function HomePage() {
  return <CheckKeyClient />;
}
