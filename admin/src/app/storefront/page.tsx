import { notFound } from "next/navigation";

/**
 * Storefront временно отключён (по требованию владельца).
 * Для включения — восстановить StorefrontClient (см. git history).
 */
export default function StorefrontPage() {
  notFound();
}
