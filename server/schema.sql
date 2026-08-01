-- SubSplit sync server — D1 schema.
--
-- Apply with:
--   npx wrangler d1 execute subsplit --remote --file=schema.sql
--
-- Two tables, no secondary indexes: every push must cost exactly one row write
-- to stay comfortably inside the D1 free tier (100,000 rows written/day).

-- One row per group. `secret` is the second half of the join token
-- (`ss_<group_id>_<secret>`) and is compared in constant time by the server.
CREATE TABLE IF NOT EXISTS groups (
  group_id   TEXT    PRIMARY KEY,
  secret     TEXT    NOT NULL,
  created_at INTEGER NOT NULL          -- ms since epoch, server clock
);

-- One row per (group, member, device). A member running two machines has two
-- rows; the server sums their window totals at read time and never sums the
-- account-wide rate-limit snapshot.
--
-- `payload` is the JSON blob {window_totals, rate_limit} exactly as normalised
-- by server/core.js, capped at 4 KB.
--
-- `server_updated_at` is stamped by the server on every accepted write and is
-- the ONLY clock used for staleness and ETags — client clocks are never trusted
-- for ordering. `client_updated_at` is stored purely so the push response can
-- report clock_skew_ms back to the member.
--
-- `seq` is the client's persisted monotonic counter. The upsert only applies
-- when `excluded.seq > devices.seq`, which makes replayed or out-of-order
-- retries no-ops.
CREATE TABLE IF NOT EXISTS devices (
  group_id          TEXT    NOT NULL,
  member_id         TEXT    NOT NULL,   -- slug(member_name); stable across devices
  device_id         TEXT    NOT NULL,   -- random uuid generated once per install
  member_name       TEXT    NOT NULL,
  payload           TEXT    NOT NULL,
  client_updated_at INTEGER NOT NULL,
  server_updated_at INTEGER NOT NULL,
  seq               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, member_id, device_id)
);
