from datetime import timedelta
from threading import RLock
from uuid import UUID

from app.errors import AppError
from app.schemas import utcnow
from app.services.calculations import find_measurements, automatic_calculation
from app.workspace_models import Record, Workspace


class WorkspaceStore:
    """One-process demo storage. No clinical documents are written to SQLite."""

    def __init__(self, ttl_seconds: int = 3600, database_url: str = ''):
        self.ttl_seconds = ttl_seconds
        self.items: dict[UUID, Workspace] = {}
        self.lock = RLock()
        self.database_url = database_url

    def initialize(self):
        if not self.database_url:
            return
        import psycopg
        with psycopg.connect(self.database_url, connect_timeout=10) as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS workspaces (id UUID PRIMARY KEY, payload JSONB NOT NULL)')
            for (payload,) in conn.execute('SELECT payload FROM workspaces'):
                workspace = Workspace.model_validate(payload)
                for job in workspace.jobs:
                    if job.status == 'transcribing':
                        job.status = 'failed'
                        job.error = 'Сервис перезапущен. Откройте сохранённую расшифровку или повторите загрузку.'
                self.items[workspace.id] = workspace
        self.purge()

    def persist(self, workspace: Workspace):
        if self.database_url:
            import psycopg
            from psycopg.types.json import Jsonb
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                conn.execute('INSERT INTO workspaces VALUES (%s,%s) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
                             (workspace.id, Jsonb(workspace.model_dump(mode='json'))))

    def delete(self, identifier: UUID):
        with self.lock:
            if self.database_url:
                import psycopg
                with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                    conn.execute('DELETE FROM workspaces WHERE id=%s', (identifier,))
            self.items.pop(identifier, None)

    def purge(self):
        with self.lock:
            for key in list(self.items):
                if self.items[key].expires_at <= utcnow():
                    self.delete(key)

    def create(self) -> Workspace:
        with self.lock:
            self.purge()
            if len(self.items) >= 20:
                raise AppError(429, "WORKSPACE_LIMIT", "Удалите одну из временных сессий.")
            workspace = Workspace(expires_at=utcnow() + timedelta(seconds=self.ttl_seconds))
            self.items[workspace.id] = workspace
            self.persist(workspace)
            return workspace.model_copy(deep=True)

    def require(self, workspace_id: UUID) -> Workspace:
        # Caller holds lock for the entire read/mutation, including revision check.
        self.purge()
        if workspace_id not in self.items:
            raise AppError(404, "WORKSPACE_EXPIRED", "Сессия удалена или истёк час хранения.")
        return self.items[workspace_id]

    def get(self, workspace_id: UUID) -> Workspace:
        with self.lock:
            return self.require(workspace_id).model_copy(deep=True)

    def editable(self, workspace_id: UUID, revision: int) -> Workspace:
        workspace = self.require(workspace_id)
        if workspace.revision != revision:
            raise AppError(409, "REVISION_CONFLICT", "Данные изменились. Обновите сессию.")
        if any(j.status == "transcribing" for j in workspace.jobs):
            raise AppError(409, "AUDIO_BUSY", "Дождитесь завершения расшифровки.")
        return workspace

    def changed(self, workspace: Workspace, context_changed: bool = False):
        workspace.revision += 1
        workspace.confirmed_revision = None
        if context_changed:
            workspace.measurements = find_measurements(workspace.records)
            workspace.automatic_calculation = automatic_calculation(workspace.records, workspace.revision)
            workspace.calculation = None
            workspace.context_stale = workspace.generated
            workspace.evidence = []
            workspace.previous_recommendations = []
            workspace.field_sources = []
        self.persist(workspace)

    @staticmethod
    def check_record(workspace: Workspace, kind: str):
        if len(workspace.records) >= 12:
            raise AppError(409, "RECORD_LIMIT", "В демо можно добавить до 12 записей.")
        if kind == "current" and any(r.kind == "current" for r in workspace.records):
            raise AppError(409, "CURRENT_EXISTS", "Удалите текущую запись перед заменой.")

    def add_record(self, workspace: Workspace, record: Record):
        self.check_record(workspace, record.kind)
        workspace.records.append(record)
        self.changed(workspace, context_changed=True)
