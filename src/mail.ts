/**
 * Buyer email delivery for card-pack orders (Brevo SMTP relay).
 *
 * One letter per paid order: order number, model, pack size and the
 * oms_buy_* key with usage instructions. Delivery is best-effort but
 * retried by the caller (order polling re-sends while emailSent is false).
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "./config.js";
import type { LavaOrder } from "./lava-orders.js";

export const mailEnabled = Boolean(config.smtpHost && config.smtpUser && config.smtpPass && config.mailFrom);

let transporter: Transporter | undefined;

function transport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

function money(usd: number): string {
  return usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export async function sendLavaOrderEmail(order: LavaOrder): Promise<void> {
  if (!mailEnabled) throw new Error("Mail delivery is disabled (SMTP_* / MAIL_FROM not configured)");
  const tier = order.tokens >= 1_000_000 ? `${order.tokens / 1_000_000}M` : `${order.tokens / 1000}k`;
  const subject = `MapleAI — заказ ${order.order} оплачен, ваш ключ доступа`;
  const text = [
    `Заказ ${order.order} оплачен — спасибо!`,
    "",
    `Модель:   ${order.model}`,
    `Пак:      ${tier} input-токенов`,
    `Сумма:    $${money(order.amountUsd)}`,
    `Ваш ключ: ${order.code}`,
    "",
    "Как пользоваться:",
    `  API base:  https://mapleai.shop/v1  (OpenAI-совместимый)`,
    `  Authorization: Bearer ${order.code}`,
    `  Остаток токенов: https://mapleai.shop/v1/prepaid/status`,
    "",
    "Пример запроса:",
    `  curl https://mapleai.shop/v1/chat/completions \\`,
    `    -H "Authorization: Bearer ${order.code}" \\`,
    `    -H "content-type: application/json" \\`,
    `    -d '{"model":"${order.model}","messages":[{"role":"user","content":"Hello"}]}'`,
    "",
    "Ключ одноразово привязан к одной модели. Если ключ закончился — просто купите новый пак.",
    "",
    "Поддержка: contact@mapleai.shop",
    "",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#12203a">
  <h2 style="margin:0 0 4px">Заказ ${order.order} оплачен ✅</h2>
  <p style="margin:0 0 18px;color:#5a6b85">Спасибо за покупку в MapleAI.</p>
  <table style="border-collapse:collapse;margin:0 0 18px">
    <tr><td style="color:#5a6b85;padding:4px 14px 4px 0">Модель</td><td><code>${order.model}</code></td></tr>
    <tr><td style="color:#5a6b85;padding:4px 14px 4px 0">Пак</td><td>${tier} input-токенов</td></tr>
    <tr><td style="color:#5a6b85;padding:4px 14px 4px 0">Сумма</td><td>$${money(order.amountUsd)}</td></tr>
    <tr><td style="color:#5a6b85;padding:4px 14px 4px 0">Ваш ключ</td><td><code style="font-size:17px;font-weight:700">${order.code}</code></td></tr>
  </table>
  <p style="margin:0 0 6px"><b>Как пользоваться</b></p>
  <p style="margin:0 0 12px">API base: <code>https://mapleai.shop/v1</code> (OpenAI-совместимый)<br>
  Заголовок: <code>Authorization: Bearer ${order.code}</code><br>
  Остаток токенов: <a href="https://mapleai.shop/v1/prepaid/status">/v1/prepaid/status</a></p>
  <p style="margin:0 0 12px;color:#5a6b85">Ключ привязан к одной модели; когда он закончится — просто купите новый пак на mapleai.shop.</p>
  <p style="margin:0;color:#5a6b85">Поддержка: contact@mapleai.shop</p>
</div>`;
  await transport().sendMail({
    from: config.mailFrom,
    to: order.email,
    subject,
    text,
    html,
  });
}
