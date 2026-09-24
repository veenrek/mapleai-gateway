const KEY = "[redacted]";
const base = "https://www.nexotoken.net";
const body = JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });

const uas = [
  ["curl-default", null],
  ["opencode", "opencode/1.18.30"],
  ["ai-sdk", "ai-sdk/1.0.0"],
  ["claude-cli", "claude-cli/2.0.0 (external, cli)"],
  ["node", "node"],
  ["axios", "axios/1.7.0"],
  ["python-requests", "python-requests/2.32.0"],
  ["openai-node", "OpenAI/NodeJS/4.0.0"],
];

async function main() {
  for (const [name, ua] of uas) {
    const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
    if (ua) headers["User-Agent"] = ua;
    let out;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body });
      const t = await r.text();
      out = t.includes('"choices"') ? `OK! ${t.slice(0,120)}` : `HTTP${r.status} ${t.slice(0,100)}`;
    } catch (e) { out = "THROW " + e.message.slice(0,60); }
    console.log(`${name.padEnd(16)} UA=${String(ua).padEnd(30)} -> ${out}`);
    await new Promise(r => setTimeout(r, 800));
  }
}
main();
