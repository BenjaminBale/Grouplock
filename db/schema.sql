CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY,
  property_name TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  share_amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'gbp',
  group_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  name TEXT,
  email TEXT,
  paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ,
  payment_intent_id TEXT,
  UNIQUE(booking_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_members_booking_id ON members(booking_id);

CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY,
  business_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  embed_key TEXT UNIQUE NOT NULL,
  stripe_account_id TEXT,
  stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_login_links (
  token TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS merchant_sessions (
  token TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS merchant_response_hours INTEGER NOT NULL DEFAULT 48;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS awaiting_since TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS guest_login_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS guest_sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
