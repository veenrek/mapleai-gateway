-- 210: keep encrypted copy of prepaid (oms_buy_*) keys so admins can view them later
ALTER TABLE marketplace_buyer_keys ADD COLUMN key_enc TEXT;
