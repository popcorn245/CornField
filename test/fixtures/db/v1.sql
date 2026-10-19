-- A data file as cornfield left it at schema version 1 (server/db.js, migration 1), with one row in each table.
-- Hand-written, so a later edit of migration 1 in place (which the module forbids) shows up as a failing test.
-- No real person and no real token: the login is an archetype, the token a placeholder.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  forge       TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  login       TEXT NOT NULL,
  token       TEXT NOT NULL,
  permission  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  checked_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE reviews (
  repo        TEXT NOT NULL,
  pr          INTEGER NOT NULL,
  slug        TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('approved', 'notes')),
  note        TEXT NOT NULL DEFAULT '',
  edits       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(edits)),
  author      TEXT NOT NULL,
  comment_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (repo, pr, slug)
) STRICT;

CREATE TABLE actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  login       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  request     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request)),
  status      INTEGER,
  answer      TEXT CHECK (answer IS NULL OR json_valid(answer))
) STRICT;
CREATE INDEX actions_at ON actions (at);

CREATE TABLE forge_cache (
  key         TEXT PRIMARY KEY,
  etag        TEXT,
  body        TEXT NOT NULL CHECK (json_valid(body)),
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
) STRICT;
CREATE INDEX forge_cache_expires_at ON forge_cache (expires_at);

INSERT INTO sessions VALUES ('session-hash-1', 'github', '1001', 'maintainer-one', 'placeholder-token', 'maintain', '2026-10-17T09:00:00.000Z', '2026-10-17T09:00:00.000Z', '2026-10-24T09:00:00.000Z');
INSERT INTO reviews VALUES ('owner/name', 7, '0013-meals', 'notes', 'Split the page in two.', '[{"op":"remove-edge","from":"a","to":"b"}]', 'maintainer-one', '9001', '2026-10-17T09:05:00.000Z');
INSERT INTO actions (at, login, action, target, request, status, answer) VALUES ('2026-10-17T09:06:00.000Z', 'maintainer-one', 'rerun', 'owner/name#check-42', '{}', 201, '{}');
INSERT INTO forge_cache VALUES ('github|1001|GET /repos/owner/name/pulls', '"etag-1"', '[]', '2026-10-17T09:00:00.000Z', '2026-10-17T09:01:00.000Z');

PRAGMA user_version = 1;
