import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.db = root / 'jobs.sqlite3'
        with self.connection() as conn:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, created REAL NOT NULL,
                updated REAL NOT NULL, language TEXT NOT NULL, vocabulary TEXT NOT NULL,
                result TEXT, error TEXT)''')

    @contextmanager
    def connection(self):
        with sqlite3.connect(self.db, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            yield conn

    def recover(self):
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET status='queued', updated=? WHERE status='processing'", (time.time(),))

    def create(self, identifier, language, vocabulary):
        now = time.time()
        with self.connection() as conn:
            conn.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,NULL,NULL)',
                         (identifier, 'queued', now, now, language, vocabulary))

    def pending(self):
        with self.connection() as conn:
            return conn.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','processing')").fetchone()[0]

    def claim(self):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            job = conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if job:
                conn.execute("UPDATE jobs SET status='processing', updated=? WHERE id=?", (time.time(), job['id']))
            return dict(job) if job else None

    def finish(self, identifier, result=None, error=None):
        with self.connection() as conn:
            conn.execute('UPDATE jobs SET status=?, updated=?, result=?, error=?, vocabulary=? WHERE id=?',
                         ('failed' if error else 'completed', time.time(),
                          json.dumps(result, ensure_ascii=False) if result is not None else None,
                          error, '', identifier))

    def get(self, identifier):
        with self.connection() as conn:
            row = conn.execute('SELECT * FROM jobs WHERE id=?', (identifier,)).fetchone()
            return dict(row) if row else None

    def delete(self, identifier):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            job = conn.execute('SELECT status FROM jobs WHERE id=?', (identifier,)).fetchone()
            if not job:
                return 'missing'
            if job['status'] == 'processing':
                return 'busy'
            conn.execute('DELETE FROM jobs WHERE id=?', (identifier,))
            (self.root / f'{identifier}.upload').unlink(missing_ok=True)
            return 'deleted'

    def expire(self, retention):
        with self.connection() as conn:
            conn.execute("DELETE FROM jobs WHERE status IN ('completed','failed') AND updated < ?", (time.time() - retention,))

