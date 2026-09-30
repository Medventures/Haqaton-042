"""Separate HTTP receiver. PostgreSQL in Compose; SQLite for local smoke tests.

Only fictional patients are seeded. This service is not a real clinic integration.
"""

import hmac
import json
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError

from app.errors import AppError, app_error_handler, validation_error_handler
from app.mis_models import MisDocument, MisReceipt
from app.schemas import utcnow

PATIENTS = [
    {
        "id": "demo-patient-001",
        "label": "Тестовый пациент А",
        "synthetic": True,
        "history": [{"date": "2026-08-10", "text": "Учебный пример: усталость, Hb 108 г/л."}],
    },
    {
        "id": "demo-patient-002",
        "label": "Тестовый пациент Б",
        "synthetic": True,
        "history": [{"date": "2026-09-02", "text": "Учебный пример: кашель в течение двух дней."}],
    },
]


class MisDatabase:
    def __init__(self, database_url: str, path: Path):
        self.database_url = database_url
        self.path = path

    @contextmanager
    def connect(self):
        if self.database_url:
            import psycopg

            conn = psycopg.connect(self.database_url, connect_timeout=5)
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=10)
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def execute(self, conn, query, params=()):
        return conn.execute(query.replace("?", "%s") if self.database_url else query, params)

    def initialize(self):
        with self.connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS demo_patients (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS demo_documents (id TEXT PRIMARY KEY, "
                "idempotency_key TEXT UNIQUE NOT NULL, "
                "payload TEXT NOT NULL, receipt TEXT NOT NULL)"
            )
            for patient in PATIENTS:
                self.execute(
                    conn,
                    "INSERT INTO demo_patients VALUES (?,?) ON CONFLICT(id) DO NOTHING",
                    (patient["id"], json.dumps(patient, ensure_ascii=False)),
                )

    def patients(self):
        with self.connect() as conn:
            return [
                json.loads(row[0])
                for row in conn.execute("SELECT data FROM demo_patients ORDER BY id")
            ]

    def save(self, body: MisDocument, key: str) -> MisReceipt:
        payload = json.dumps(body.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
        receipt = MisReceipt(
            document_id=uuid4(),
            consultation_id=body.consultation_id,
            revision=body.revision,
            patient_id=body.patient_id,
            received_at=utcnow(),
        )
        with self.connect() as conn:
            if not self.execute(
                conn, "SELECT id FROM demo_patients WHERE id=?", (body.patient_id,)
            ).fetchone():
                raise AppError(404, "PATIENT_NOT_FOUND", "Тестовый пациент не найден.")
            self.execute(
                conn,
                "INSERT INTO demo_documents VALUES (?,?,?,?) "
                "ON CONFLICT(idempotency_key) DO NOTHING",
                (str(receipt.document_id), key, payload, receipt.model_dump_json()),
            )
            existing = self.execute(
                conn, "SELECT payload, receipt FROM demo_documents WHERE idempotency_key=?", (key,)
            ).fetchone()
            if existing[0] != payload:
                raise AppError(
                    409,
                    "IDEMPOTENCY_CONFLICT",
                    "Эта версия уже отправлена с другим содержимым или пациентом.",
                )
            receipt = MisReceipt.model_validate_json(existing[1])
        # The transaction is committed before acknowledging success.
        return receipt

    def document(self, identifier: UUID):
        with self.connect() as conn:
            row = self.execute(
                conn, "SELECT payload, receipt FROM demo_documents WHERE id=?", (str(identifier),)
            ).fetchone()
        if not row:
            raise AppError(404, "DOCUMENT_NOT_FOUND", "Документ не найден в тестовой МИС.")
        return {"document": json.loads(row[0]), "receipt": json.loads(row[1])}


def create_mock_mis(
    *, api_key: str | None = None, database_url: str | None = None, path: Path | None = None
) -> FastAPI:
    secret = api_key if api_key is not None else os.getenv("MIS_API_KEY", "")
    database = MisDatabase(
        database_url if database_url is not None else os.getenv("MIS_DATABASE_URL", ""),
        path or Path(os.getenv("MIS_DATA_DIR", "data/mock-mis")) / "mis.sqlite3",
    )

    @asynccontextmanager
    async def lifespan(app):
        if len(secret) < 24:
            raise RuntimeError("MIS_API_KEY must contain at least 24 characters")
        database.initialize()
        yield

    application = FastAPI(
        title="MedHub — тестовая МИС (только синтетические данные)", lifespan=lifespan
    )
    application.state.database = database
    application.add_exception_handler(AppError, app_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)

    def authenticate(x_api_key: str = Header(default="")):
        if not secret or not hmac.compare_digest(secret.encode(), x_api_key.encode()):
            raise AppError(401, "INVALID_API_KEY", "Тестовая МИС отклонила API-ключ.")

    @application.middleware("http")
    async def no_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.get("/health")
    def health():
        with database.connect() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "mode": "test_mis"}

    @application.get("/patients", dependencies=[Depends(authenticate)])
    def patients():
        return database.patients()

    @application.post("/documents", response_model=MisReceipt, dependencies=[Depends(authenticate)])
    def receive(body: MisDocument, idempotency_key: str = Header(min_length=1, max_length=200)):
        expected = f"{body.consultation_id}:{body.revision}"
        if idempotency_key != expected:
            raise AppError(
                422, "INVALID_IDEMPOTENCY_KEY", "Ключ должен соответствовать консультации и версии."
            )
        if not any(body.fields.model_dump().values()):
            raise AppError(422, "EMPTY_FORM", "Пустой документ не принимается.")
        return database.save(body, idempotency_key)

    @application.get("/documents/{identifier}", dependencies=[Depends(authenticate)])
    def document(identifier: UUID):
        return database.document(identifier)

    return application


app = create_mock_mis()
