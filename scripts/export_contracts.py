"""Run from repository root: python scripts/export_contracts.py."""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import Settings
from app.main import create_app
from app.schemas import Consultation, ConsultationStatus, Job, JobStatus
from app.services.demo import demo_fields, demo_transcript


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


write_json(
    ROOT / "contracts/openapi.json", create_app(Settings(_env_file=None)).openapi()
)
fixed_date = datetime(2026, 9, 30, tzinfo=UTC)
consultation = Consultation(
    id=UUID("00000000-0000-4000-8000-000000000001"),
    patient_id="demo-patient-001",
    language="ru",
    status=ConsultationStatus.REVIEW,
    revision=2,
    source="demo",
    fields=demo_fields(),
    transcript=demo_transcript(),
    warnings=["Синтетический пример; WhisperX и LLM не вызывались."],
    created_at=fixed_date,
    updated_at=fixed_date,
)
write_json(
    ROOT / "contracts/examples/consultation.json", consultation.model_dump(mode="json")
)
for status in JobStatus:
    job = Job(
        id=UUID("00000000-0000-4000-8000-000000000002"),
        consultation_id=consultation.id,
        mode="demo",
        status=status,
        created_at=fixed_date,
        updated_at=fixed_date,
        error={"code": "DEMO_FAILED", "message": "Не удалось загрузить пример."}
        if status == JobStatus.FAILED
        else None,
    )
    write_json(
        ROOT / f"contracts/examples/job-{status.value}.json",
        job.model_dump(mode="json"),
    )
