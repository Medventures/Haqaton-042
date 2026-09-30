"""Opt-in demo library: PostgreSQL in Compose, SQLite for local preview."""
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from app.config import Settings
from app.workspace_models import SpeechResult

class SpeechCache:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = settings.data_dir / 'speech-demo-cache.sqlite3'
        self.postgres = bool(settings.database_url)

    @contextmanager
    def connect(self):
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            conn = psycopg.connect(self.settings.database_url, row_factory=dict_row, connect_timeout=10)
            conn.execute('CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL, created_at TEXT NOT NULL, result JSONB NOT NULL, audio BYTEA)')
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute('CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL, created_at TEXT NOT NULL, result TEXT NOT NULL, audio BLOB)')
            if 'audio' not in {row[1] for row in conn.execute('PRAGMA table_info(transcripts)')}:
                conn.execute('ALTER TABLE transcripts ADD COLUMN audio BLOB')
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def query(self, conn, sql, params=()):
        return conn.execute(sql.replace('?', '%s') if self.postgres else sql, params)

    def key(self, audio: bytes, language: str):
        config = json.dumps([self.settings.speech_cache_version, language,
                             self.settings.whisperx_vocabulary], ensure_ascii=False).encode()
        return hashlib.sha256(config + bytes([0]) + audio).hexdigest()

    def get(self, identifier: str):
        if not self.settings.speech_cache_enabled:
            return None
        with self.connect() as conn:
            row = self.query(conn, 'SELECT result FROM transcripts WHERE id=?', (identifier,)).fetchone()
        if not row:
            return None
        return SpeechResult.model_validate(row['result']) if isinstance(row['result'], dict) else SpeechResult.model_validate_json(row['result'])

    def get_audio(self, identifier: str):
        if not self.settings.speech_cache_enabled:
            return None
        with self.connect() as conn:
            row = self.query(conn, 'SELECT audio FROM transcripts WHERE id=?', (identifier,)).fetchone()
        return bytes(row['audio']) if row and row['audio'] is not None else None

    def put(self, identifier: str, title: str, language: str, result: SpeechResult, audio: bytes | None = None):
        if not self.settings.speech_cache_enabled:
            return
        with self.connect() as conn:
            payload = result.model_dump_json()
            if self.postgres:
                from psycopg.types.json import Jsonb
                payload = Jsonb(result.model_dump(mode='json'))
            self.query(conn, 'INSERT INTO transcripts (id,title,language,created_at,result,audio) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, result=excluded.result, audio=COALESCE(excluded.audio,transcripts.audio)',
                       (identifier, title, language, datetime.now(timezone.utc).isoformat(), payload, audio))

    def list(self):
        if not self.settings.speech_cache_enabled:
            return []
        with self.connect() as conn:
            return [dict(r) for r in conn.execute('SELECT id,title,language,created_at,(audio IS NOT NULL) AS has_audio FROM transcripts ORDER BY created_at DESC')]

    def delete(self, identifier: str):
        if self.settings.speech_cache_enabled:
            with self.connect() as conn:
                self.query(conn, 'DELETE FROM transcripts WHERE id=?', (identifier,))
