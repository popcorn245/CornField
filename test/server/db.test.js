/**
 * @vitest-environment node
 *
 * cornfield's SQLite file (server/db.js): a fresh data folder gets the four tables at the latest version; an old
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
const TABLES = ['actions', 'forge_cache', 'reviews', 'sessions'];

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

  it('makes the data folder and a fresh file with the four tables at the latest version', () => {
    const dataDir = path.join(tmp, 'data', 'nested');
    db = openStore(dataDir);
    expect(fs.existsSync(path.join(dataDir, DB_FILE))).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(TABLES);
    expect(columns(db, 'sessions')).toEqual(['id', 'forge', 'user_id', 'login', 'token', 'permission', 'created_at', 'checked_at', 'expires_at']);
    expect(columns(db, 'reviews')).toEqual(['repo', 'pr', 'slug', 'verdict', 'note', 'edits', 'author', 'comment_id', 'at']);
    expect(columns(db, 'actions')).toEqual(['id', 'at', 'login', 'action', 'target', 'request', 'status', 'answer']);
    expect(columns(db, 'forge_cache')).toEqual(['key', 'etag', 'body', 'fetched_at', 'expires_at']);
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
    expect(db.prepare('SELECT pr, slug, verdict, edits FROM reviews').get()).toEqual({ pr: 7, slug: '0013-meals', verdict: 'notes', edits: '[{"op":"remove-edge","from":"a","to":"b"}]' });
    expect(db.prepare('SELECT count(*) AS n FROM actions').get().n).toBe(1);
    expect(db.prepare('SELECT etag FROM forge_cache').get().etag).toBe('"etag-1"');
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
    for (const t of TABLES) expect(a.prepare(`PRAGMA table_xinfo(${t})`).all()).toEqual(b.prepare(`PRAGMA table_xinfo(${t})`).all());
    a.close();
    b.close();
  });
});
