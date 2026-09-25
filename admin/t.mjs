const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhdXRoZW50aWNhdGVkIjp0cnVlLCJpYXQiOjE3ODc3NDMwODAsImV4cCI6MTc4Nzc0NjY4MH0.7mm8fkwHLSXXbzy8ZMurI8mz7qBR1fZgKRU_l91c2g4";
function usageCount(conn) { return fetch("http://localhost:7777/api/v1/internal").catch(()=>0); } // placeholder
async function go(model) {
  const r = await fetch("http://localhost:7777/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "auth_token=" + JWT },
    body: JSON.stringify({ model, stream: false, max_completion_tokens: 8, messages: [{ role: "user", content: "reply: ok" }] })
  });
  const j = await r.json();
  return { status: r.status, usage: j.usage, modelReturned: j.model, error: j.error?.message };
}
console.log("1) закреплённо ttm/gpt-5.6-sol:", JSON.stringify(await go("ttm/gpt-5.6-sol")).slice(0,300));
console.log("2) через комбо gpt-5.6-sol:", JSON.stringify(await go("gpt-5.6-sol")).slice(0,300));
