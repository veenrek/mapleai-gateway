const KEY = "[redacted]";
const base = "https://www.nexotoken.net";
const body = JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });

async function main() {
  const outcomes = {};
  const successes = [];
  for (let i = 1; i <= 60; i++) {
    const t = new Date().toISOString().slice(11, 19);
    let label;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body,
      });
      const txt = await r.text();
      if (txt.includes('"choices"')) label = `OK(${r.status})`;
      else if (txt.includes("Endpoint not found")) label = "404-endpoint";
      else if (txt.includes("请求处理失败")) label = "500-upstream";
      else label = `other(${r.status})`;
      if (label.startsWith("OK")) successes.push(t);
    } catch (e) { label = "throw:" + e.message.slice(0, 30); }
    outcomes[label] = (outcomes[label] || 0) + 1;
    if (i % 10 === 0) console.log(`  ...${i} done`);
    await new Promise((res) => setTimeout(res, 700));
  }
  console.log("OUTCOMES:", JSON.stringify(outcomes, null, 2));
  console.log("SUCCESS TIMES:", successes.join(", ") || "none");
}
main();
