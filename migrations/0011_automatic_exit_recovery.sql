CREATE TABLE automatic_exit_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version TEXT NOT NULL CHECK(version='AUTOMATIC_EXIT_RECOVERY_V1')
);
CREATE TABLE automatic_exit_goals (
  id TEXT PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES follower_positions(id),
  opening_fill_id TEXT NOT NULL REFERENCES paper_fills(id),
  intent_id TEXT NOT NULL REFERENCES follower_trades(execution_key),
  intent_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('WAITING','QUOTING','COMMITTING','COMPLETED','ATTENTION')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  result_json TEXT,
  reason TEXT NOT NULL,
  UNIQUE(position_id,opening_fill_id)
);
CREATE TABLE automatic_exit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL REFERENCES automatic_exit_goals(id),
  at_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
