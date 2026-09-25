-- Product-sale fulfillment on top of lava payments.
-- offer_id links the payment to a shop product; delivery_* store the fulfilled code/link.
ALTER TABLE lava_payments ADD COLUMN offer_id TEXT;
ALTER TABLE lava_payments ADD COLUMN supplier_name TEXT;
ALTER TABLE lava_payments ADD COLUMN supplier_item_id TEXT;
ALTER TABLE lava_payments ADD COLUMN delivery_text TEXT;
ALTER TABLE lava_payments ADD COLUMN fulfilled_at TEXT;

-- Which supplier items back each shop offer (ordered by priority; cheapest
-- in-stock wins at fulfillment time, this list defines candidates + fallback).
CREATE TABLE IF NOT EXISTS shop_product_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  supplier_item_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_shop_product_sources_offer ON shop_product_sources(offer_id, active);

-- Seed: Gemini 18M (link) @ RoboticVN — the site LAVA_OFFER_ID product.
INSERT INTO shop_product_sources (offer_id, supplier, supplier_item_id, priority)
SELECT '0cd35ce5-45bb-4951-92e7-61da30c86892', 'robotic', 'variant_01KSWAPGBBSVP8F5DWHAC50BKG', 1
WHERE NOT EXISTS (
  SELECT 1 FROM shop_product_sources
  WHERE offer_id = '0cd35ce5-45bb-4951-92e7-61da30c86892' AND supplier_item_id = 'variant_01KSWAPGBBSVP8F5DWHAC50BKG'
);
