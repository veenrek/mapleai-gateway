import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getLastSolvencyReport, runSolvencyCheck } from "@/lib/marketplace/crypto/solvencyMonitor";
import { handleCorsOptions } from "@/shared/utils/cors";
import { NextResponse } from "next/server";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Treasury solvency report: on-chain assets vs DB liabilities.
 * `?refresh=1` runs a live check; default returns the last scheduled result.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const wantsRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const report = wantsRefresh ? await runSolvencyCheck() : getLastSolvencyReport();
    return NextResponse.json({ report });
  } catch (error) {
    return NextResponse.json(
      { error: { message: String((error as Error)?.message || error), type: "server_error" } },
      { status: 500 }
    );
  }
}
