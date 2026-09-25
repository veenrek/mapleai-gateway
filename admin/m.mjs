const KEY = "oms_buy_cZADDv3SPzPs4IB5krJNwrL3VMBzGMQedOl-NpkyQEA";
async function keyUsed() {
  const r = await fetch("http://localhost:7777/api/marketplace/check-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY }) });
  return (await r.json()).tokens.used;
}
async function stream(url, body) {
  const res = await fetch("http://localhost:7777" + url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({ ...body, stream: true })
  });
  let usage = null, full = "";
  const reader = res.body.getReader(); const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    full += dec.decode(value, { stream: true });
  }
  const m = full.match(/data: \{"type":"response.completed".*\}|\{"usage":\{[^}]*\}[^}]*\}(?![^ ]*)/s);
  const usageLine = full.split("\n").filter(l => l.includes('"usage"')).slice(-1)[0];
  return { status: res.status, usageLine: usageLine?.slice(0, 300) };
}
const a0 = await keyUsed();
const c = await stream("/v1/chat/completions", { model: "gpt-5.6-sol", max_completion_tokens: 8, stream_options: { include_usage: true }, messages: [{ role: "user", content: "say hi" }] });
await new Promise(r => setTimeout(r, 1500));
const a1 = await keyUsed();
console.log("chat/completions stream:", c.status, "| settle Δ =", a1 - a0);
console.log("  usage line:", c.usageLine || "НЕТ usage в SSE!");
const r2 = await stream("/v1/responses", { model: "gpt-5.6-sol", input: "say hi" });
await new Promise(r => setTimeout(r, 1500));
const a2 = await keyUsed();
console.log("responses stream:", r2.status, "| settle Δ =", a2 - a1);
console.log("  usage line:", r2.usageLine || "НЕТ usage в SSE!");
