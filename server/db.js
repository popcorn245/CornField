/**
 * @module server/db
 *
 * cornfield's own SQLite file: `cornfield.db` in the data folder (`config.dataDir`, never a checkout), over Node's
 * built-in `node:sqlite`, so still no dependency. It holds what the server must remember between restarts:
 *
 *   sessions      a signed-in user: who, their permission on the repo, their own forge token (never sent to a browser)
 *   reviews       a cache of the latest review per spec PR and proposal (the PR comment is the truth)
 *   actions       the audit of every action cornfield takes on the forge: who, what, when, the forge's answer
 *   forge_cache   forge answers kept for a while (an ETag and a body), so a page load is not a dozen API calls
 *   review_tokens the review API's tokens: a SHA-256 hash, owner, label, expiry, revoked, last used (never the token)
 *   hook_seen     the (pull request, head, proposal) triples whose `spec.ready` event was sent, so a restart sends none twice;
 *                 a row with `pr = 0` says the repo has been looked at once (server/hooks.js)
 *   landings      the spec PRs an approval is waiting to land (`proposals.approveLands`), so a restart picks them up (server/lander.js)
 *   thread_seen   the (repo, issue, comment) triples whose thread.* hook event was sent, and each thread's last-seen time, so a
 *                 restart sends none twice and a look asks the forge only for what is new (server/hooks.js, server/threads.js);
 *                 a row with `issue = 0` says the repo's threads have been looked at once
 *   runs          the agent runs cornfield asked for: the request, where it was posted, the latest report, the pull request found for
 *                 it and when anything last happened (server/agent-runs.js, migration 7); review_tokens also keep a scope
 *   run_seen      what has been seen of each run (a comment judged, a hook event sent), so a restart sends and judges nothing twice
 *   run_events    what happened to each run, in order, for its timeline; run_reads what was read to work out its nodes (migration 9, issue #82)
 *                 sessions also keep a forge refresh token, the access token's expiry and when `session.expiring` was sent (migration 5)
 *
 * The schema is a list of numbered migrations (`MIGRATIONS`); the file's `PRAGMA user_version` is the number of
 * the last one it has. `openStore` runs the ones a file lacks, each in its own transaction, so a fresh file and one
 * an older cornfield left both end at the latest version and no row is lost. A migration, once released, is never
 * edited: a change is a new one at the end. A file from a newer cornfield (a higher version than this code knows)
 * is refused rather than guessed at.
 *
 * The folder is made private to its owner (0700) and the file too (0600): a session row holds a forge token.
 * Times are ISO strings; JSON columns hold text that `json_valid` accepts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The file's name in the data folder */
export const DB_FILE = 'cornfield.db';

/**
 * The schema, oldest first: migration `n` (1-based) moves a file from version `n - 1` to `n`.
 * Each is SQL run as one transaction. Append only.
 * @type {readonly string[]}
 */
export const MIGRATIONS = Object.freeze([
  // 1: the four tables of spec 0001 section 3
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,               -- a hash of the cookie's value, never the value itself
    forge       TEXT NOT NULL,                  -- 'github' | 'forgejo'
    user_id     TEXT NOT NULL,                  -- the forge's id for the user
    login       TEXT NOT NULL,
    token       TEXT NOT NULL,                  -- the user's own forge token
    permission  TEXT NOT NULL,                  -- what the forge said: 'admin' | 'maintain' | 'write' | 'read' | 'none'
    created_at  TEXT NOT NULL,
    checked_at  TEXT NOT NULL,                  -- when the permission was last asked (again every 15 minutes)
    expires_at  TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sessions_expires_at ON sessions (expires_at);

  CREATE TABLE reviews (
    repo        TEXT NOT NULL,                  -- 'owner/name'
    pr          INTEGER NOT NULL,
    slug        TEXT NOT NULL,                  -- the proposal file's slug
    verdict     TEXT NOT NULL CHECK (verdict IN ('approved', 'notes')),
    note        TEXT NOT NULL DEFAULT '',
    edits       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(edits)),
    author      TEXT NOT NULL,                  -- the admin's login
    comment_id  TEXT NOT NULL,                  -- the PR comment that is the review
    at          TEXT NOT NULL,
    PRIMARY KEY (repo, pr, slug)
  ) STRICT;

  CREATE TABLE actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    login       TEXT NOT NULL,                  -- who asked
    action      TEXT NOT NULL,                  -- 'review' | 'merge' | 'rerun' | …
    target      TEXT NOT NULL,                  -- what it was done to: 'owner/name#12', a check's id…
    request     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request)),
    status      INTEGER,                        -- the forge's HTTP status, or null when it did not answer
    answer      TEXT CHECK (answer IS NULL OR json_valid(answer))
  ) STRICT;
  CREATE INDEX actions_at ON actions (at);

  CREATE TABLE forge_cache (
    key         TEXT PRIMARY KEY,               -- the forge, the token's user and the request
    etag        TEXT,
    body        TEXT NOT NULL CHECK (json_valid(body)),
    fetched_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  ) STRICT;
  CREATE INDEX forge_cache_expires_at ON forge_cache (expires_at);
  `,
  // 2: event hooks (server/hooks.js): which spec PR heads have been announced
  `
  CREATE TABLE hook_seen (
    repo        TEXT NOT NULL,                  -- 'owner/name'
    pr          INTEGER NOT NULL,
    head_sha    TEXT NOT NULL,                  -- the PR's head when cornfield first saw it
    slug        TEXT NOT NULL,                  -- the proposal file's slug
    at          TEXT NOT NULL,
    PRIMARY KEY (repo, pr, head_sha, slug)
  ) STRICT;
  `,
  // 3: review tokens, for the review API (server/review-tokens.js)
  `
  CREATE TABLE review_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  TEXT NOT NULL UNIQUE,           -- the SHA-256 of the token, hex; the token itself is never kept
    user_id     TEXT NOT NULL,                  -- the owner, by the forge's id (a rename is followed)
    login       TEXT NOT NULL,                  -- the owner's login when it was made
    label       TEXT NOT NULL,                  -- what the owner calls it; the review comment names it
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    last_used   TEXT
  ) STRICT;
  CREATE INDEX review_tokens_user_id ON review_tokens (user_id);
  `,
  // 4: landing on approval (server/lander.js): a spec PR waiting for its checks, to be landed as the approver
  `
  CREATE TABLE landings (
    repo        TEXT NOT NULL,                  -- 'owner/name'
    pull        INTEGER NOT NULL,
    slug        TEXT NOT NULL,                  -- the proposal that was approved
    sha         TEXT NOT NULL,                  -- the head that was approved: the only one that may land
    user_id     TEXT NOT NULL,                  -- the approver, by the forge's id: it lands as them, with their own sign-in
    login       TEXT NOT NULL,                  -- their login when they approved (for the audit)
    started     TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('pending', 'landed', 'cancelled', 'left-open', 'done')),
    PRIMARY KEY (repo, pull)
  ) STRICT;
  `,
  // 5: long sessions (server/auth.js, server/hooks.js): the forge's refresh token (encrypted, like the access token) and
  // when the access token expires, so an expiring forge token is renewed; and when \`session.expiring\` was sent for a session
  `
  ALTER TABLE sessions ADD COLUMN refresh_token TEXT NOT NULL DEFAULT '';  -- the forge's refresh token, encrypted like \`token\`; '' when there is none
  ALTER TABLE sessions ADD COLUMN token_expires_at TEXT;                   -- when the access token stops working; NULL when it does not expire
  ALTER TABLE sessions ADD COLUMN expiring_sent_at TEXT;                   -- when the \`session.expiring\` hook event was sent; NULL before
  `,
  // 6: threads (server/threads.js, server/hooks.js): which comments of a thread have been announced. The thread itself is the
  // forge's (an issue's comments, or a spec PR's conversation); this only remembers what was told, never what was said
  `
  CREATE TABLE thread_seen (
    repo        TEXT NOT NULL,                  -- 'owner/name'
    issue       INTEGER NOT NULL,               -- the issue or pull request number of the thread; 0 with comment '' says the repo has been looked at once
    comment     TEXT NOT NULL,                  -- '' the thread itself (opened); a comment's id (message); 'link:<id>' or 'link:body' (linked); 'pr:<n>' a spec PR that names the thread
    stamp       TEXT NOT NULL DEFAULT '',       -- the forge's own time: the comment's last edit, or (on the '' row) the thread's last update when it was looked at
    at          TEXT NOT NULL,                  -- when cornfield first saw it
    PRIMARY KEY (repo, issue, comment)
  ) STRICT;
  `,
  // 7: agent runs (server/agent-runs.js, spec 0005): a table of the runs cornfield asked for, what it has seen of them, and a scope on
  // the API tokens so one store holds review tokens and agent tokens
  `
  ALTER TABLE review_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'review' CHECK (scope IN ('review', 'agent'));  -- what the token may call: POST /api/reviews, or POST /api/agent-requests

  CREATE TABLE runs (
    run_id            TEXT PRIMARY KEY,           -- run-<ulid>, minted with the request
    repo              TEXT NOT NULL,              -- 'owner/name'
    kind              TEXT NOT NULL,
    profile           TEXT,
    issue             INTEGER,                    -- what the run is about (at least one of the three)
    proposal          TEXT,
    thread            INTEGER,
    target            INTEGER NOT NULL,           -- the issue or pull request the request, and the stop, were posted on
    comment_id        TEXT NOT NULL DEFAULT '',   -- the request comment; '' while the post is in flight (the row already counts as open)
    comment_url       TEXT,
    request           TEXT NOT NULL CHECK (json_valid(request)),   -- the request as posted: no credential in it, ever
    requested_by      TEXT NOT NULL,
    requested_by_id   TEXT NOT NULL,
    requested_at      TEXT NOT NULL,
    via               TEXT NOT NULL DEFAULT 'dashboard',           -- 'dashboard' | 'api'
    state             TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'claimed', 'working', 'done', 'failed', 'stopped')),   -- the runner's latest report
    reported_at       TEXT,
    reported_by       TEXT,
    note              TEXT,
    url               TEXT,
    tokens            INTEGER,
    cost              REAL,
    stop_requested_at TEXT,
    stop_requested_by TEXT,
    pull              INTEGER,                    -- the pull request that carries the run's id
    pull_state        TEXT CHECK (pull_state IS NULL OR pull_state IN ('open', 'merged', 'closed')),
    pull_url          TEXT,
    pull_by           TEXT,
    pull_trusted      INTEGER NOT NULL DEFAULT 0, -- 1 when its author is a runner, a listed agent author or a maintainer: only then does it move the state
    linked_via        TEXT CHECK (linked_via IS NULL OR linked_via IN ('body', 'commit', 'branch')),
    branch            TEXT,
    head_sha          TEXT,
    checks            TEXT CHECK (checks IS NULL OR checks IN ('success', 'failure', 'running', 'none')),
    last_activity     TEXT NOT NULL               -- the latest report, push or pull request activity (or the request itself)
  ) STRICT;
  CREATE INDEX runs_repo ON runs (repo, requested_at);

  CREATE TABLE run_seen (
    run_id      TEXT NOT NULL,                    -- '' for what belongs to no run (a pull request's commits already read)
    key         TEXT NOT NULL,                    -- 'c:<comment>:<n>' a block judged, 'ev:…' a hook event sent, 'commits:<pull>@<sha>'
    at          TEXT NOT NULL,
    PRIMARY KEY (run_id, key)
  ) STRICT;
  `,
  // 8: reserved for push and pull transports and runner tokens (#81); nothing here, so that the next one is 9 whichever lands first
  `-- reserved: #81`,
  // 9: runs on the map (server/agent-runs.js, issue #82): what happened to each run in order (the timeline), and what was read to
  // work out the nodes it changes, kept by head sha so the forge is asked once per push
  `
  CREATE TABLE run_events (
    run_id  TEXT NOT NULL,
    key     TEXT NOT NULL,                        -- what happened, once: 'report:<comment>:<n>', 'push:<sha>', 'pull:<n>:opened', 'checks:<sha>:<summary>' ...
    at      TEXT NOT NULL,                        -- when it happened (the forge's time where it says, else when cornfield saw it)
    kind    TEXT NOT NULL CHECK (kind IN ('claimed', 'report', 'stop-requested', 'push', 'pull-opened', 'checks', 'merged', 'closed')),
    actor   TEXT,
    ref     TEXT,                                 -- the report's state, the sha pushed, the pull request number, the checks summary
    note    TEXT,                                 -- the runner's words, as written: the page escapes them
    url     TEXT,
    PRIMARY KEY (run_id, key)
  ) STRICT;
  CREATE INDEX run_events_at ON run_events (run_id, at);

  CREATE TABLE run_reads (
    run_id  TEXT NOT NULL,
    source  TEXT NOT NULL CHECK (source IN ('files', 'mentions')),   -- the files a branch changes at sha, or the [[mentions]] of what the run is about
    sha     TEXT NOT NULL DEFAULT '',
    data    TEXT NOT NULL CHECK (json_valid(data)),
    at      TEXT NOT NULL,
    PRIMARY KEY (run_id, source)
  ) STRICT;
  `,
]);

/** The version a file is at: its `user_version` */
export function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Runs the migrations a file lacks, in order, each in its own transaction: one that fails leaves the file at the
 * version before it, and throws.
 * @param {DatabaseSync} db
 * @param {readonly string[]} [migrations] the schema (tests pass their own)
 * @returns {{ from: number, to: number }} the version before and after
 */
export function migrate(db, migrations = MIGRATIONS) {
  const newer = (v) => new Error(`The data file is at schema version ${v}, newer than this cornfield knows (${migrations.length}). Run a newer cornfield, or restore an older data folder.`);
  const from = schemaVersion(db);
  if (from > migrations.length) throw newer(from);
  for (;;) {
    // The version is read again inside the write lock: another process may have migrated the file meanwhile
    db.exec('BEGIN IMMEDIATE');
    const at = schemaVersion(db);
    if (at >= migrations.length) {
      db.exec('COMMIT');
      if (at > migrations.length) throw newer(at);
      break;
    }
    const n = at + 1;
    try {
      db.exec(migrations[n - 1]);
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${n} of the data file failed: ${err.message}`, { cause: err });
    }
  }
  return { from, to: migrations.length };
}

/**
 * Opens (creating when needed) `cornfield.db` in the data folder and brings it to the latest schema.
 * @param {string} dataDir the data folder (`config.dataDir`); made, private, when missing
 * @param {{ file?: string, migrations?: readonly string[] }} [opts] another file name, or another schema (tests)
 * @returns {DatabaseSync} the open file; the caller closes it (`db.close()`)
 */
export function openStore(dataDir, { file = DB_FILE, migrations = MIGRATIONS } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('openStore needs the data folder.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const where = path.join(dataDir, file);
  const db = new DatabaseSync(where);
  try {
    fs.chmodSync(where, 0o600);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db, migrations);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
