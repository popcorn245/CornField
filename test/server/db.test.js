/**
 * @vitest-environment node
 *
 * cornfield's SQLite file (server/db.js): a fresh data folder gets its tables at the latest version; an old
 * file (test/fixtures/db/v1.sql, as version 1 left it) opens with its rows kept and the later migrations run; a
 * migration that fails leaves the file where it was; a file from a newer cornfield is refused; the folder and the
 * file are private to their owner. Every test works in its own temporary folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { openStore, migrate, schemaVersion, MIGRATIONS, DB_FILE } from '../../server/db.js';
import { CORNFIELD } from '../helpers.js';

const V1_SQL = fs.readFileSync(path.join(CORNFIELD, 'test', 'fixtures', 'db', 'v1.sql'), 'utf8');
const V1_TABLES = ['actions', 'forge_cache', 'reviews', 'sessions'];
const TABLES = ['actions', 'forge_cache', 'hook_seen', 'landings', 'review_tokens', 'reviews', 'run_events', 'run_mirrors', 'run_reads', 'run_seen', 'runs', 'sessions', 'thread_seen'];

const tables = (db) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** A file at version 1, with the fixture's rows, written straight with SQLite (not through openStore) */
function writeOldFile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, DB_FILE));
  db.exec(V1_SQL);
  db.close();
}

describe('openStore', () => {
  let tmp;
  let db;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-db-')); });
  afterEach(() => {
    if (db?.isOpen) db.close();
    db = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('makes the data folder and a fresh file with its tables at the latest version', () => {
    const dataDir = path.join(tmp, 'data', 'nested');
    db = openStore(dataDir);
    expect(fs.existsSync(path.join(dataDir, DB_FILE))).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(TABLES);
    expect(columns(db, 'sessions')).toEqual(['id', 'forge', 'user_id', 'login', 'token', 'permission', 'created_at', 'checked_at', 'expires_at', 'refresh_token', 'token_expires_at', 'expiring_sent_at']);
    expect(columns(db, 'reviews')).toEqual(['repo', 'pr', 'slug', 'verdict', 'note', 'edits', 'author', 'comment_id', 'at']);
    expect(columns(db, 'actions')).toEqual(['id', 'at', 'login', 'action', 'target', 'request', 'status', 'answer']);
    expect(columns(db, 'forge_cache')).toEqual(['key', 'etag', 'body', 'fetched_at', 'expires_at']);
    expect(columns(db, 'review_tokens')).toEqual(['id', 'token_hash', 'user_id', 'login', 'label', 'created_at', 'expires_at', 'revoked_at', 'last_used', 'scope']);
    expect(columns(db, 'hook_seen')).toEqual(['repo', 'pr', 'head_sha', 'slug', 'at']);
    expect(columns(db, 'thread_seen')).toEqual(['repo', 'issue', 'comment', 'stamp', 'at']);
    expect(columns(db, 'landings')).toEqual(['repo', 'pull', 'slug', 'sha', 'user_id', 'login', 'started', 'state']);
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  });

  it.skipIf(process.platform === 'win32')('keeps the folder and the file private to their owner (a session holds a token)', () => {
    const dataDir = path.join(tmp, 'data');
    db = openStore(dataDir);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, DB_FILE)).mode & 0o777).toBe(0o600);
  });

  it('opens an old file with its rows kept, and the same file again with nothing to do', () => {
    writeOldFile(tmp);
    db = openStore(tmp);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(TABLES);
    expect(db.prepare('SELECT login, permission FROM sessions').all()).toEqual([{ login: 'maintainer-one', permission: 'maintain' }]);
    // migration 5: an old session has no refresh token, a token that does not expire, and no session.expiring sent
    expect(db.prepare('SELECT refresh_token, token_expires_at, expiring_sent_at FROM sessions').get()).toEqual({ refresh_token: '', token_expires_at: null, expiring_sent_at: null });
    expect(db.prepare('SELECT pr, slug, verdict, edits FROM reviews').get()).toEqual({ pr: 7, slug: '0013-meals', verdict: 'notes', edits: '[{"op":"remove-edge","from":"a","to":"b"}]' });
    expect(db.prepare('SELECT count(*) AS n FROM actions').get().n).toBe(1);
    expect(db.prepare('SELECT etag FROM forge_cache').get().etag).toBe('"etag-1"');
    expect(db.prepare('SELECT count(*) AS n FROM review_tokens').get().n).toBe(0); // migration 2 added the table, empty
    db.close();
    db = openStore(tmp);
    expect(migrate(db)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
  });

  it('runs only the migrations an old file lacks, keeping its rows', () => {
    writeOldFile(tmp);
    const later = [...MIGRATIONS, "ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';"];
    db = openStore(tmp, { migrations: later });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length + 1);
    expect(db.prepare('SELECT login, name FROM sessions').get()).toEqual({ login: 'maintainer-one', name: '' });
  });

  it('leaves the file at the version before a migration that fails, and says which one', () => {
    writeOldFile(tmp);
    const later = [...MIGRATIONS, 'CREATE TABLE threads (id TEXT PRIMARY KEY);', 'CREATE TABLE half (x TEXT); ALTER TABLE nowhere ADD COLUMN y TEXT;'];
    expect(() => openStore(tmp, { migrations: later })).toThrow(`Migration ${MIGRATIONS.length + 2} of the data file failed`);
    db = openStore(tmp, { migrations: later.slice(0, -1) });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length + 1);
    expect(tables(db)).toEqual([...TABLES, 'threads']);
  });

  it('refuses a file from a newer cornfield and leaves it untouched', () => {
    writeOldFile(tmp);
    const raw = new DatabaseSync(path.join(tmp, DB_FILE));
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 3}`);
    raw.close();
    expect(() => openStore(tmp)).toThrow(/schema version \d+, newer than this cornfield knows/);
    const after = new DatabaseSync(path.join(tmp, DB_FILE));
    expect(schemaVersion(after)).toBe(MIGRATIONS.length + 3);
    after.close();
  });

  it('holds the tables to their checks: a verdict, JSON in the JSON columns, one cached review per PR and proposal', () => {
    db = openStore(tmp);
    const review = db.prepare('INSERT INTO reviews (repo, pr, slug, verdict, edits, author, comment_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    review.run('owner/name', 3, 'slug', 'approved', '[]', 'maintainer-one', '1', '2026-10-17T00:00:00.000Z');
    expect(() => review.run('owner/name', 3, 'slug', 'approved', '[]', 'maintainer-one', '2', '2026-10-17T00:00:00.000Z')).toThrow(/UNIQUE/);
    expect(() => review.run('owner/name', 4, 'slug', 'maybe', '[]', 'maintainer-one', '1', '2026-10-17T00:00:00.000Z')).toThrow(/CHECK/);
    expect(() => review.run('owner/name', 5, 'slug', 'notes', 'not json', 'maintainer-one', '1', '2026-10-17T00:00:00.000Z')).toThrow(/CHECK/);
    expect(() => review.run('owner/name', 'six', 'slug', 'notes', '[]', 'maintainer-one', '1', '2026-10-17T00:00:00.000Z')).toThrow(/cannot store TEXT value in INTEGER column/);
    const action = db.prepare('INSERT INTO actions (at, login, action, target, status, answer) VALUES (?, ?, ?, ?, ?, ?)');
    expect(action.run('2026-10-17T00:00:00.000Z', 'maintainer-one', 'merge', 'owner/name#3', null, null).lastInsertRowid).toBe(1);
    expect(() => action.run('2026-10-17T00:00:00.000Z', 'maintainer-one', 'merge', 'owner/name#3', 405, '{oops')).toThrow(/CHECK/);
  });

  it('needs a data folder', () => {
    expect(() => openStore('')).toThrow('openStore needs the data folder.');
    expect(() => openStore(undefined)).toThrow('openStore needs the data folder.');
  });
});

describe('migration 7 on a file at 6', () => {
  it('keeps the review tokens a file holds, as review tokens, and adds the runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-db-7-'));
    try {
      const six = openStore(dir, { migrations: MIGRATIONS.slice(0, 6) });
      six.prepare("INSERT INTO review_tokens (token_hash, user_id, login, label, created_at, expires_at) VALUES ('h', '1001', 'maintainer-one', 'old bot', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')").run();
      six.close();
      const db = openStore(dir);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT label, scope FROM review_tokens').all()).toEqual([{ label: 'old bot', scope: 'review' }]);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('runs', 'run_seen') ORDER BY name").all().map((r) => r.name)).toEqual(['run_seen', 'runs']);
      expect(() => db.prepare("UPDATE review_tokens SET scope = 'admin'").run()).toThrow(/CHECK/);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the migrations', () => {
  it('end with the version the file says, and are numbered from 1 in the order they run', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(Object.isFrozen(MIGRATIONS)).toBe(true);
    db.close();
  });

  it('match the version-1 fixture: migration 1 has not been edited in place', () => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    migrate(a, MIGRATIONS.slice(0, 1));
    b.exec(V1_SQL);
    const schema = (db) => db.prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(schema(a)).toEqual(schema(b));
    for (const t of V1_TABLES) expect(a.prepare(`PRAGMA table_xinfo(${t})`).all()).toEqual(b.prepare(`PRAGMA table_xinfo(${t})`).all());
    a.close();
    b.close();
  });
});

describe('migration 8 (push and pull transports, runner tokens)', () => {
  const hash = (n) => `${String(n).padStart(2, '0')}`.repeat(32);
  const at = '2026-11-01T00:00:00.000Z';

  it('moves a file at version 7 to 8: tokens, their ids and their sequence kept, runner scope allowed, runs get a transport', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(9); // 9 is runs on the map, 10 a run that waits, below
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, 7));
    expect(schemaVersion(db)).toBe(7);
    const add = db.prepare("INSERT INTO review_tokens (token_hash, user_id, login, label, scope, created_at, expires_at) VALUES (?, '1', 'maint', ?, ?, ?, ?)");
    add.run(hash(1), 'review one', 'review', at, at);
    add.run(hash(2), 'agent one', 'agent', at, at);
    add.run(hash(3), 'dropped', 'agent', at, at);
    db.prepare('DELETE FROM review_tokens WHERE id = 3').run(); // the highest id is gone: the sequence must still remember it
    db.prepare(`INSERT INTO runs (run_id, repo, kind, issue, target, comment_id, request, requested_by, requested_by_id, requested_at, last_activity)
      VALUES ('run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'o/n', 'code', 12, 12, '77', '{}', 'maint', '1', ?, ?)`).run(at, at);
    // One revoked and used, one used: every column of every row comes through as it was
    db.prepare("UPDATE review_tokens SET revoked_at = '2026-11-02T00:00:00.000Z', last_used = '2026-11-01T12:00:00.000Z' WHERE id = 1").run();
    db.prepare("UPDATE review_tokens SET last_used = '2026-11-03T00:00:00.000Z' WHERE id = 2").run();
    const before = db.prepare('SELECT id, token_hash, user_id, login, label, created_at, expires_at, revoked_at, last_used, scope FROM review_tokens ORDER BY id').all();

    expect(migrate(db, MIGRATIONS.slice(0, 8))).toEqual({ from: 7, to: 8 });
    expect(db.prepare('SELECT id, token_hash, user_id, login, label, created_at, expires_at, revoked_at, last_used, scope FROM review_tokens ORDER BY id').all()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT id, label, scope FROM review_tokens ORDER BY id').all()).toEqual([{ id: 1, label: 'review one', scope: 'review' }, { id: 2, label: 'agent one', scope: 'agent' }]);
    expect(db.prepare('SELECT run_id, transport, claimed_by, claimed_at, comment_id FROM runs').all()).toEqual([{ run_id: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', transport: 'forge', claimed_by: null, claimed_at: null, comment_id: '77' }]);
    expect(columns(db, 'review_tokens')).toEqual(['id', 'token_hash', 'user_id', 'login', 'label', 'created_at', 'expires_at', 'revoked_at', 'last_used', 'scope']);
    // the runner scope is allowed now, and a made-up one is not; ids carry on past the dropped one
    const id = Number(add.run(hash(4), 'runner one', 'runner', at, at).lastInsertRowid);
    expect(id).toBe(4);
    expect(() => add.run(hash(5), 'x', 'bogus', at, at)).toThrow();
    expect(() => add.run(hash(1), 'dup', 'review', at, at)).toThrow(); // the hash is still unique
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'review_tokens_user_id'").all()).toHaveLength(1);
    expect(() => db.prepare("UPDATE runs SET transport = 'carrier-pigeon'").run()).toThrow();
    db.close();
  });
});

describe('migration 9 (runs on the map)', () => {
  it('moves a file at version 8 to 9: the timeline and what was read for the nodes, held to their kinds', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, 8));
    expect(schemaVersion(db)).toBe(8);
    expect(migrate(db, MIGRATIONS.slice(0, 9))).toEqual({ from: 8, to: 9 });
    db.prepare("INSERT INTO run_events (run_id, key, at, kind) VALUES ('r', 'push:a', '2026-11-05T10:00:00Z', 'push')").run();
    expect(() => db.prepare("INSERT INTO run_events (run_id, key, at, kind) VALUES ('r', 'x', '2026-11-05T10:00:00Z', 'review')").run()).toThrow(); // nothing records a review
    db.prepare("INSERT INTO run_reads (run_id, source, sha, data, at) VALUES ('r', 'files', 'a', 'null', '2026-11-05T10:00:00Z')").run(); // a forge that cannot list them
    expect(() => db.prepare("INSERT INTO run_reads (run_id, source, sha, data, at) VALUES ('r', 'mentions', '', 'not json', '2026-11-05T10:00:00Z')").run()).toThrow();
    db.close();
  });
});

describe('migration 10 (a run that waits for an answer, issue #101)', () => {
  it('moves a file at version 9 to 10: the rows and indexes kept, waiting and answers allowed, nothing else', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, 9));
    const insert = db.prepare(`INSERT INTO runs (run_id, repo, kind, target, comment_id, request, requested_by, requested_by_id, requested_at, state, note, transport, claimed_by, last_activity)
      VALUES (?, 'owner/name', 'code', 7, '77', '{}', 'maintainer-one', '1', '2026-11-05T10:00:00Z', ?, 'kept', 'pull', 3, '2026-11-05T10:05:00Z')`);
    insert.run('run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'working');
    expect(() => insert.run('run-01JC8Z3Q5M7VXK2RT9N4B6HDEG', 'waiting')).toThrow(); // not yet
    db.prepare("INSERT INTO run_events (run_id, key, at, kind, actor, ref, note) VALUES ('run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'report:a', '2026-11-05T10:01:00Z', 'report', 'x', 'working', 'n')").run();
    expect(() => db.prepare("INSERT INTO run_events (run_id, key, at, kind) VALUES ('r', 'x', '2026-11-05T10:00:00Z', 'answered')").run()).toThrow();
    expect(migrate(db)).toEqual({ from: 9, to: MIGRATIONS.length });
    expect(db.prepare('SELECT run_id, state, note, transport, claimed_by, comment_id, answer_action FROM runs').all()).toEqual([{ run_id: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', state: 'working', note: 'kept', transport: 'pull', claimed_by: 3, comment_id: '77', answer_action: null }]);
    expect(db.prepare('SELECT key, kind, note FROM run_events').all()).toEqual([{ key: 'report:a', kind: 'report', note: 'n' }]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('runs_repo', 'runs_queue', 'run_events_at') ORDER BY name").all().map((r) => r.name)).toEqual(['run_events_at', 'runs_queue', 'runs_repo']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    insert.run('run-01JC8Z3Q5M7VXK2RT9N4B6HDEG', 'waiting');
    db.prepare("UPDATE runs SET answer_action = 'reply', answer_text = 'plan B', answer_at = '2026-11-05T10:06:00Z', answer_by = 'maintainer-one' WHERE state = 'waiting'").run();
    expect(() => db.prepare("UPDATE runs SET answer_action = 'approve'").run()).toThrow();
    expect(() => db.prepare("UPDATE runs SET state = 'paused'").run()).toThrow();
    db.prepare("INSERT INTO run_events (run_id, key, at, kind, ref, note) VALUES ('r', 'answer:1', '2026-11-05T10:00:00Z', 'answered', 'reply', 'plan B')").run();
    db.close();
  });
});

describe('migration 10 on a file that already has runs (every column, #108 and #109 rows)', () => {
  const RUN_A = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEA';
  const RUN_B = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEB';
  const BY = JSON.stringify({ runner: 'laptop', mintedBy: 'maintainer-one' }); // a runner's `by`, kept as JSON text (#108)
  const seed = (db) => {
    db.prepare(`INSERT INTO runs (run_id, repo, kind, profile, issue, proposal, thread, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, via,
        state, reported_at, reported_by, note, url, tokens, cost, stop_requested_at, stop_requested_by, pull, pull_state, pull_url, pull_by, pull_trusted, linked_via,
        branch, head_sha, checks, last_activity, transport, claimed_by, claimed_at)
      VALUES (?, 'owner/name', 'code', 'fast', 12, '0040-meals', 14, 12, '901', 'https://forge.test/c/901', '{"version":1}', 'maintainer-one', '1001', '2026-11-05T10:00:00Z', 'hand',
        'working', '2026-11-05T10:01:00Z', 'runner-bot', 'a note', 'https://logs.example.org/1', 1200, 0.42, '2026-11-05T10:02:00Z', 'maintainer-two', 31, 'open', 'https://forge.test/pull/31', 'runner-bot', 1, 'body',
        'agent/x', 'abc123', 'running', '2026-11-05T10:03:00Z', 'forge', NULL, NULL)`).run(RUN_A);
    db.prepare(`INSERT INTO runs (run_id, repo, kind, target, request, requested_by, requested_by_id, requested_at, via, state, reported_at, reported_by, last_activity, transport, claimed_by, claimed_at)
      VALUES (?, 'owner/name', 'summary', 15, '{}', 'maintainer-one', '1001', '2026-11-05T11:00:00Z', 'api', 'claimed', '2026-11-05T11:01:00Z', ?, '2026-11-05T11:01:00Z', 'pull', 4, '2026-11-05T11:01:00Z')`).run(RUN_B, BY);
    db.prepare("INSERT INTO run_events (run_id, key, at, kind, actor, ref, note, url) VALUES (?, 'stop:901', '2026-11-05T10:02:00Z', 'stop-requested', 'maintainer-two', NULL, 'why', 'https://forge.test/c/902')").run(RUN_A);
    db.prepare("INSERT INTO run_events (run_id, key, at, kind, actor, ref) VALUES (?, 'report:x', '2026-11-05T11:01:00Z', 'claimed', ?, 'claimed')").run(RUN_B, BY);
    db.prepare("INSERT INTO run_seen (run_id, key, at) VALUES (?, 'c:901:0', '2026-11-05T10:00:00Z')").run(RUN_A);
    db.prepare("INSERT INTO run_reads (run_id, source, sha, data, at) VALUES (?, 'files', 'abc123', '[]', '2026-11-05T10:03:00Z')").run(RUN_A);
  };

  it('copies every row and column unchanged, keeps the indexes and the other run tables, and runs once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-db10-'));
    try {
      const old = new DatabaseSync(path.join(dir, DB_FILE));
      migrate(old, MIGRATIONS.slice(0, 9));
      seed(old);
      const runsBefore = old.prepare('SELECT * FROM runs ORDER BY run_id').all();
      const eventsBefore = old.prepare('SELECT * FROM run_events ORDER BY run_id, key').all();
      const indexesBefore = old.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all();
      expect(old.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'").get().n).toBe(0); // no trigger to carry over
      for (const t of ['runs', 'run_events', 'run_seen', 'run_reads']) expect(old.prepare(`PRAGMA foreign_key_list(${t})`).all(), t).toEqual([]); // nothing refers to them, nor they to anything
      old.close();
      // openStore turns foreign keys on before it migrates: the rebuild must hold with them on
      const db = openStore(dir);
      expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      const runsAfter = db.prepare('SELECT * FROM runs ORDER BY run_id').all();
      expect(runsAfter.map(({ answer_action, answer_text, answer_at, answer_by, ...rest }) => rest)).toEqual(runsBefore);
      expect(runsAfter.every((r) => r.answer_action === null && r.answer_text === null && r.answer_at === null && r.answer_by === null)).toBe(true);
      expect(JSON.parse(runsAfter.find((r) => r.run_id === RUN_B).reported_by)).toEqual({ runner: 'laptop', mintedBy: 'maintainer-one' });
      expect(runsAfter.find((r) => r.run_id === RUN_A).via).toBe('hand');
      expect(db.prepare('SELECT * FROM run_events ORDER BY run_id, key').all()).toEqual(eventsBefore);
      expect(db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()).toEqual(indexesBefore);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_new'").all()).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM run_seen').get().n).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM run_reads').get().n).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
      // a second open (or a second migrate) changes nothing
      expect(migrate(db)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
      db.close();
      const again = openStore(dir);
      expect(again.prepare('SELECT * FROM runs ORDER BY run_id').all()).toEqual(runsAfter);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration 11 (a thread for every run, #104) adds run_mirrors to a file with runs and changes no run', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, 10));
    seed(db);
    const runsBefore = db.prepare('SELECT * FROM runs ORDER BY run_id').all();
    const eventsBefore = db.prepare('SELECT * FROM run_events ORDER BY run_id, key').all();
    expect(migrate(db, MIGRATIONS.slice(0, 11))).toEqual({ from: 10, to: 11 });
    expect(db.prepare('SELECT * FROM runs ORDER BY run_id').all()).toEqual(runsBefore);
    expect(db.prepare('SELECT * FROM run_events ORDER BY run_id, key').all()).toEqual(eventsBefore);
    // no run has a status comment yet: the first look posts one for a run that has moved
    expect(db.prepare('SELECT count(*) AS n FROM run_mirrors').get().n).toBe(0);
    db.prepare("INSERT INTO run_mirrors (run_id, number, at) VALUES (?, 12, '2026-11-05T12:00:00Z')").run(RUN_A);
    expect(db.prepare('SELECT comment_id, hash, busy, gone FROM run_mirrors').get()).toEqual({ comment_id: null, hash: '', busy: null, gone: 0 });
    expect(() => db.prepare("UPDATE run_mirrors SET gone = 2").run()).toThrow();
    expect(() => db.prepare("INSERT INTO run_mirrors (run_id, number, at) VALUES (?, 12, '2026-11-05T12:00:00Z')").run(RUN_A)).toThrow(); // one per run
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    db.close();
  });
});
