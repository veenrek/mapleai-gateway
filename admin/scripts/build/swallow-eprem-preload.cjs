// Preloaded into the spawned `next build` child (build-next-isolated.mjs).
// Windows: @vercel/nft file tracing walks legacy junctions like
// C:\Users\<user>\Application Data and dies with an EPERM unhandledRejection
// even though the missed paths are system compat links, never part of the
// bundle. Swallow exactly those; anything else stays fatal.
process.on("unhandledRejection", (err) => {
  const code = err && typeof err === "object" ? err.code : null;
  if (code === "EPERM" || code === "EACCES") {
    console.warn(`[build] ignored fs scan error (code=${code}) — legacy junction, not bundleable`);
    return;
  }
  console.error("[build] unhandled rejection:", err);
  process.exitCode = 1;
});
