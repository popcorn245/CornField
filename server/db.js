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
 *                 (review, agent, or runner: migration 8, which also gives a run its transport and the runner token that claimed it)
 *   run_seen      what has been seen of each run (a comment judged, a hook event sent), so a restart sends and judges nothing twice
 *   run_events    what happened to each run, in order, for its timeline; run_reads what was read to work out its nodes (migration 9, issue #82);
 *                 migration 10 lets a run wait (state 'waiting') and keeps a maintainer's answer to it (answer_* on runs, 'answered' events)
 *   run_mirrors   the one status comment cornfield keeps for a run in its thread (migration 11, issue #104): which comment, and a hash of the
 *                 text last written to it, so a look edits it only when the run has moved
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
  // 8: push and pull transports, and runner tokens (server/agent-runs.js, server/runner-api.js, spec 0005 D2, D5): a run records how its request
  // travels and which runner token claimed it; the token scope check gains 'runner'. SQLite cannot change a CHECK, so review_tokens is rebuilt
  // (the documented way: a new table, the rows copied with their ids, the old one dropped, the new one renamed) and keeps its id sequence
  `
  ALTER TABLE runs ADD COLUMN transport  TEXT NOT NULL DEFAULT 'forge' CHECK (transport IN ('forge', 'push', 'pull'));  -- how the request reaches the runner; a push or pull run has no request comment (comment_id stays '')
  ALTER TABLE runs ADD COLUMN claimed_by INTEGER;   -- the runner token (review_tokens.id) that claimed a pull run, or that first reported on a push run
  ALTER TABLE runs ADD COLUMN claimed_at TEXT;
  CREATE INDEX runs_queue ON runs (repo, transport, state, requested_at);

  CREATE TABLE review_tokens_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  TEXT NOT NULL UNIQUE,
    user_id     TEXT NOT NULL,
    login       TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    last_used   TEXT,
    scope       TEXT NOT NULL DEFAULT 'review' CHECK (scope IN ('review', 'agent', 'runner'))  -- what the token may call: POST /api/reviews, POST /api/agent-requests, or the runner routes
  ) STRICT;
  INSERT INTO review_tokens_new (id, token_hash, user_id, login, label, created_at, expires_at, revoked_at, last_used, scope)
    SELECT id, token_hash, user_id, login, label, created_at, expires_at, revoked_at, last_used, scope FROM review_tokens;
  UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'review_tokens'), 0)) WHERE name = 'review_tokens_new';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'review_tokens_new', seq FROM sqlite_sequence WHERE name = 'review_tokens'
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'review_tokens_new');
  DROP TABLE review_tokens;
  ALTER TABLE review_tokens_new RENAME TO review_tokens;
  CREATE INDEX review_tokens_user_id ON review_tokens (user_id);
  `,
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
  // 10: a run may wait for a maintainer (server/agent-runs.js, issue #101): the runner's report `waiting` and the maintainer's answer. SQLite cannot
  // change a CHECK, so runs (whose `state` gains 'waiting') and run_events (whose `kind` gains 'answered') are rebuilt the documented way: a new
  // table, the rows copied, the old one dropped, the new one renamed, the indexes made again. The answer is kept on the run: the latest one only.
  // No foreign key refers to either table and neither has a trigger, so `PRAGMA foreign_keys` (on, and not changeable inside the migration's
  // transaction) leaves the rebuild alone; a later migration that adds one must rebuild with that in mind (test/server/db.test.js checks it)
  `
  CREATE TABLE runs_new (
    run_id            TEXT PRIMARY KEY,
    repo              TEXT NOT NULL,
    kind              TEXT NOT NULL,
    profile           TEXT,
    issue             INTEGER,
    proposal          TEXT,
    thread            INTEGER,
    target            INTEGER NOT NULL,
    comment_id        TEXT NOT NULL DEFAULT '',
    comment_url       TEXT,
    request           TEXT NOT NULL CHECK (json_valid(request)),
    requested_by      TEXT NOT NULL,
    requested_by_id   TEXT NOT NULL,
    requested_at      TEXT NOT NULL,
    via               TEXT NOT NULL DEFAULT 'dashboard',
    state             TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped')),   -- the runner's latest report
    reported_at       TEXT,
    reported_by       TEXT,
    note              TEXT,
    url               TEXT,
    tokens            INTEGER,
    cost              REAL,
    stop_requested_at TEXT,
    stop_requested_by TEXT,
    pull              INTEGER,
    pull_state        TEXT CHECK (pull_state IS NULL OR pull_state IN ('open', 'merged', 'closed')),
    pull_url          TEXT,
    pull_by           TEXT,
    pull_trusted      INTEGER NOT NULL DEFAULT 0,
    linked_via        TEXT CHECK (linked_via IS NULL OR linked_via IN ('body', 'commit', 'branch')),
    branch            TEXT,
    head_sha          TEXT,
    checks            TEXT CHECK (checks IS NULL OR checks IN ('success', 'failure', 'running', 'none')),
    last_activity     TEXT NOT NULL,
    transport         TEXT NOT NULL DEFAULT 'forge' CHECK (transport IN ('forge', 'push', 'pull')),
    claimed_by        INTEGER,
    claimed_at        TEXT,
    answer_action     TEXT CHECK (answer_action IS NULL OR answer_action IN ('continue', 'stop', 'reply')),   -- a maintainer's answer to the latest wait; a new 'waiting' report clears it
    answer_text       TEXT,
    answer_at         TEXT,
    answer_by         TEXT
  ) STRICT;
  INSERT INTO runs_new (run_id, repo, kind, profile, issue, proposal, thread, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, via,
      state, reported_at, reported_by, note, url, tokens, cost, stop_requested_at, stop_requested_by, pull, pull_state, pull_url, pull_by, pull_trusted, linked_via,
      branch, head_sha, checks, last_activity, transport, claimed_by, claimed_at)
    SELECT run_id, repo, kind, profile, issue, proposal, thread, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, via,
      state, reported_at, reported_by, note, url, tokens, cost, stop_requested_at, stop_requested_by, pull, pull_state, pull_url, pull_by, pull_trusted, linked_via,
      branch, head_sha, checks, last_activity, transport, claimed_by, claimed_at FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_new RENAME TO runs;
  CREATE INDEX runs_repo ON runs (repo, requested_at);
  CREATE INDEX runs_queue ON runs (repo, transport, state, requested_at);

  CREATE TABLE run_events_new (
    run_id  TEXT NOT NULL,
    key     TEXT NOT NULL,
    at      TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('claimed', 'report', 'stop-requested', 'answered', 'push', 'pull-opened', 'checks', 'merged', 'closed')),
    actor   TEXT,
    ref     TEXT,                                 -- for 'answered': the action (continue, stop, reply); note is a reply's text
    note    TEXT,
    url     TEXT,
    PRIMARY KEY (run_id, key)
  ) STRICT;
  INSERT INTO run_events_new (run_id, key, at, kind, actor, ref, note, url) SELECT run_id, key, at, kind, actor, ref, note, url FROM run_events;
  DROP TABLE run_events;
  ALTER TABLE run_events_new RENAME TO run_events;
  CREATE INDEX run_events_at ON run_events (run_id, at);
  `,
  // 11: a thread for every run (server/agent-runs.js, issue #104): the ONE comment cornfield keeps in a run's thread, edited in place as the run moves.
  // A table of its own, so no existing table is rebuilt. `busy` is a claim (a time) held while the comment is being posted or edited, so two looks at
  // once cannot post two comments; `gone` says someone deleted the comment, and cornfield does not post another
  `
  CREATE TABLE run_mirrors (
    run_id      TEXT PRIMARY KEY,
    number      INTEGER NOT NULL,                 -- the issue or pull request the comment is on
    comment_id  TEXT,                             -- the forge's id of the comment, once it is posted
    comment_url TEXT,
    hash        TEXT NOT NULL DEFAULT '',         -- a hash of the text last written to it
    busy        TEXT,
    gone        INTEGER NOT NULL DEFAULT 0 CHECK (gone IN (0, 1)),
    at          TEXT NOT NULL
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
  // The file and the ones SQLite keeps beside it are plain files or not there yet, never a link: SQLite would write through one, and the
  // chmod below would change its target (a data folder put inside a checkout could hold a committed link)
  for (const name of [where, `${where}-wal`, `${where}-shm`, `${where}-journal`]) {
    let stats = null;
    try { stats = fs.lstatSync(name); } catch { /* not there yet */ }
    if (stats && !stats.isFile()) throw new Error(`${name} is not a plain file: cornfield keeps its database only in plain files in the data folder.`);
  }
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
