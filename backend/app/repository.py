import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TypeVar
from uuid import UUID

from pydantic import BaseModel

from app.errors import AppError

Document = TypeVar("Document", bound=BaseModel)


class Repository:
    """Small persistent store. Transactions serialize document edits for this prototype."""

    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS documents (
                kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            )""")

    def insert(self, kind: str, identifier: UUID, document: BaseModel) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT INTO documents VALUES (?, ?, ?)",
                (kind, str(identifier), document.model_dump_json()),
            )

    def get(self, kind: str, identifier: UUID, schema: type[Document]) -> Document:
        with self.connection() as db:
            row = db.execute(
                "SELECT body FROM documents WHERE kind = ? AND id = ?", (kind, str(identifier))
            ).fetchone()
        if row is None:
            raise AppError(404, "NOT_FOUND", "Запись не найдена.")
        return schema.model_validate_json(row[0])

    def mutate(
        self,
        kind: str,
        identifier: UUID,
        schema: type[Document],
        change: Callable[[Document], None],
    ) -> Document:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT body FROM documents WHERE kind = ? AND id = ?", (kind, str(identifier))
            ).fetchone()
            if row is None:
                raise AppError(404, "NOT_FOUND", "Запись не найдена.")
            document = schema.model_validate_json(row[0])
            change(document)
            db.execute(
                "UPDATE documents SET body = ? WHERE kind = ? AND id = ?",
                (document.model_dump_json(), kind, str(identifier)),
            )
        return document

    def recover_interrupted_jobs(self) -> None:
        """BackgroundTasks is not a durable queue; expose interrupted work after a restart."""
        from app.schemas import Consultation, ConsultationStatus, Job, JobError, JobStatus, utcnow

        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for identifier, body in db.execute(
                "SELECT id, body FROM documents WHERE kind = 'job'"
            ).fetchall():
                job = Job.model_validate_json(body)
                if job.status not in (JobStatus.COMPLETED, JobStatus.FAILED):
                    job.status = JobStatus.FAILED
                    job.error = JobError(
                        code="PROCESSING_INTERRUPTED",
                        message="Сервер перезапущен. Повторите запрос.",
                    )
                    job.updated_at = utcnow()
                    db.execute(
                        "UPDATE documents SET body = ? WHERE kind = 'job' AND id = ?",
                        (job.model_dump_json(), identifier),
                    )
            for identifier, body in db.execute(
                "SELECT id, body FROM documents WHERE kind = 'consultation'"
            ).fetchall():
                consultation = Consultation.model_validate_json(body)
                if consultation.status == ConsultationStatus.PROCESSING:
                    consultation.status = ConsultationStatus.DRAFT
                    consultation.updated_at = utcnow()
                    db.execute(
                        "UPDATE documents SET body = ? WHERE kind = 'consultation' AND id = ?",
                        (consultation.model_dump_json(), identifier),
                    )
