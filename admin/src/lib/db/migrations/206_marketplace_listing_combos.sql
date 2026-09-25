-- Combo-backed marketplace listings: a listing may route buyer requests
-- through an omniroute combo (id references combos.id) instead of a single
-- pinned provider connection. The combo engine owns target selection,
-- strategy, and fallback; the listing's connection_id stays as the billing
-- anchor for the seller ledger.
ALTER TABLE marketplace_listings ADD COLUMN combo_id TEXT;
