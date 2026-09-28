// Serves tools/ over localhost so Phantom/MetaMask inject providers reliably
// (extensions treat file:// pages differently; some builds skip them entirely).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 4317;
const ROOT = __dirname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/sign-ownership.html";
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`open: http://localhost:${PORT}/sign-ownership.html`);
  });
