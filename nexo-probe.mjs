const KEY = "[redacted]";
const URL_ = "https://www.nexotoken.net/v1/chat/completions";

async function post(label, body, headers = {}) {
  try {
    const r = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers },
      body,
    });
    const t = await r.text();
    console.log(`${label} -> HTTP ${r.status} :: ${t.slice(0, 220)}`);
  } catch (e) {
    console.log(`${label} -> THROW ${e.message}`);
  }
}

(async () => {
  const proper = JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "Привет" }], stream: false });
  const escaped = '{\\"model\\":\\"gpt-5.6-sol\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Привет\\"}],\\"stream\\":false}';
  console.log("proper body:", proper);
  console.log("escaped body:", escaped);
  for (let i = 1; i <= 3; i++) await post(`proper#${i}`, proper);
  for (let i = 1; i <= 3; i++) await post(`escaped#${i}`, escaped);
})();
