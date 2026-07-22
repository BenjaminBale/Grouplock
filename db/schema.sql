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
