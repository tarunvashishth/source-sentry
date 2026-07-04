-- Migration number: 0003
-- `notified` previously meant "we attempted delivery", not "delivery succeeded" —
-- track actual failures so future work (a "channel unreachable" warning) has real data.
ALTER TABLE changes ADD COLUMN notify_failed_count INTEGER NOT NULL DEFAULT 0;
