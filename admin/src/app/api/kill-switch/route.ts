import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listKillSwitches, setKillSwitch, type KillLevel } from "@/server/killSwitch/manager";

const PUT_SCHEMA = z.object({
  level: z.enum(["global", "provider", "combo", "model"]),
  target: z.string().min(1).max(200).nullable().optional(),
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
});

/**
 * GET /api/kill-switch — list all kill-switch entries (management only).
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return Response.json({ switches: listKillSwitches() }, { status: 200 });
  } catch (error) {
    return Response.json(
      { error: { message: (error as Error).message, type: "server_error" } },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/kill-switch — enable/disable a kill-switch scope (management only).
 * Body: { level: "global"|"provider"|"combo"|"model", target?, enabled, reason? }
 * `target` is required for all levels except "global".
 */
export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request" } },
      { status: 400 }
    );
  }

  const parsed = PUT_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid body", type: "invalid_request", issues: parsed.error.issues } },
      { status: 400 }
    );
  }

  const { level, enabled, reason } = parsed.data;
  const target = parsed.data.target ?? null;
  if (level !== "global" && !target) {
    return Response.json(
      { error: { message: `target is required for level "${level}"`, type: "invalid_request" } },
      { status: 400 }
    );
  }
  if (level === "global" && target) {
    return Response.json(
      { error: { message: 'target must be omitted for level "global"', type: "invalid_request" } },
      { status: 400 }
    );
  }

  try {
    setKillSwitch(level as KillLevel, level === "global" ? null : target, enabled, reason);
    return Response.json({ ok: true, level, target: level === "global" ? null : target, enabled });
  } catch (error) {
    return Response.json(
      { error: { message: (error as Error).message, type: "server_error" } },
      { status: 500 }
    );
  }
}
