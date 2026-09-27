import { getCombos } from "@/lib/localDb";

/**
 * Marker for a dynamic allowlist: a prepaid key whose allowedModels contains
 * this value may use every currently active (non-hidden) combo, resolved at
 * request time instead of being frozen at issuance.
 */
export const ALL_COMBOS_MARKER = "__all_combos__";

/** Expand the allowlist; the __all_combos__ marker resolves to all active combo names. */
export async function resolveAllowedModels(
  allowedModels: string[] | null | undefined
): Promise<string[]> {
  const list = Array.isArray(allowedModels) ? allowedModels : [];
  if (!list.includes(ALL_COMBOS_MARKER)) return list;
  const combos = await getCombos();
  const comboNames = combos
    .filter((combo) => combo.isActive !== false && combo.isHidden !== true)
    .map((combo) => combo.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const rest = list.filter((model) => model !== ALL_COMBOS_MARKER);
  return [...new Set([...rest, ...comboNames])];
}
