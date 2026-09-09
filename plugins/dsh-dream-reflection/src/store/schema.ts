/**
 * SQLite schema and data boundaries for the plugin store.
 *
 * Schema versions are monotonic and never guessed: an unknown on-disk version
 * fails loud at open. JSON columns are validated by the provider before write.
 *
 * @module dsh-dream-reflection/store/schema
 */

export const SCHEMA_VERSION = 1

/** The complete DDL for a fresh database at {@link SCHEMA_VERSION}. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspaceKey TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  lastSuccessAt INTEGER,
  nextEligibleAt INTEGER,
  failureCount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cursors (
  workspaceKey TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  lastSettledSeq INTEGER NOT NULL,
  contentHash TEXT NOT NULL,
  PRIMARY KEY (workspaceKey, sessionId)
);

CREATE TABLE IF NOT EXISTS leases (
  scopeKey TEXT PRIMARY KEY,
  holderId TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  heartbeatAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  runId TEXT PRIMARY KEY,
  workspaceKey TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  sourceDigest TEXT,
  usage TEXT,
  errorCode TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  finishedAt INTEGER
);

CREATE TABLE IF NOT EXISTS candidates (
  candidateId TEXT PRIMARY KEY,
  workspaceKey TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  claims TEXT NOT NULL,
  limitations TEXT NOT NULL,
  reviewQuestion TEXT NOT NULL,
  sourceRefs TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  nearVector TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  decidedAt INTEGER
);

CREATE TABLE IF NOT EXISTS budget (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  reservedCalls INTEGER NOT NULL DEFAULT 0,
  actualCalls INTEGER NOT NULL DEFAULT 0,
  reservedTokens INTEGER NOT NULL DEFAULT 0,
  actualTokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs (workspaceKey, createdAt);
CREATE INDEX IF NOT EXISTS idx_candidates_workspace ON candidates (workspaceKey, status);
`
