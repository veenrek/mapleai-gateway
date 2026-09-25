/**
 * Kept as a stub: Lava.top webhooks are not used in this deployment.
 * Payment confirmation happens via polling — see
 * /api/marketplace/payments/lava/reconcile. Respond 200 so any stray
 * configured callback stops retrying.
 */
export async function POST() {
  return Response.json({ received: true, hint: "use /reconcile polling instead" }, { status: 200 });
}
