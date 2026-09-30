from uuid import UUID, uuid4

from app.errors import AppError
from app.repository import Repository
from app.schemas import (
    Consultation,
    ConsultationFields,
    ConsultationStatus,
    Job,
    JobError,
    JobStatus,
    Segment,
    Transcript,
    utcnow,
)
from app.services.workflow import check_editable, check_revision


def demo_transcript() -> Transcript:
    return Transcript(
        language="ru",
        segments=[
            Segment(id="s1", start=0, end=2, speaker="doctor", text="Что вас беспокоит?"),
            Segment(
                id="s2",
                start=2,
                end=7,
                speaker="patient",
                text="Три дня температура и сухой кашель.",
            ),
            Segment(id="s3", start=7, end=9, speaker="doctor", text="Есть аллергия на лекарства?"),
            Segment(id="s4", start=9, end=12, speaker="patient", text="На пенициллин."),
        ],
    )


def demo_fields() -> ConsultationFields:
    return ConsultationFields(
        complaints="Температура, сухой кашель.",
        anamnesis="Симптомы в течение трёх дней.",
        allergies="Со слов пациента: аллергия на пенициллин.",
    )


class DemoService:
    """Explicit synthetic fixture, never used as a fallback for real audio."""

    def __init__(self, repository: Repository):
        self.repository = repository

    def enqueue(self, identifier: UUID, expected_revision: int) -> Job:
        def reserve(consultation: Consultation) -> None:
            check_revision(consultation, expected_revision)
            check_editable(consultation)
            if consultation.revision != 1 or any(consultation.fields.model_dump().values()):
                raise AppError(
                    409, "DEMO_REQUIRES_EMPTY_DRAFT", "Создайте новую консультацию для демо."
                )
            consultation.status = ConsultationStatus.PROCESSING
            consultation.updated_at = utcnow()

        self.repository.mutate("consultation", identifier, Consultation, reserve)
        job = Job(id=uuid4(), consultation_id=identifier, mode="demo")
        try:
            self.repository.insert("job", job.id, job)
        except Exception:
            self.release(identifier)
            raise
        return job

    def release(self, identifier: UUID) -> None:
        def change(consultation: Consultation) -> None:
            if consultation.status == ConsultationStatus.PROCESSING:
                consultation.status = ConsultationStatus.DRAFT
                consultation.updated_at = utcnow()

        self.repository.mutate("consultation", identifier, Consultation, change)

    def run(self, job_id: UUID) -> None:
        job = self.repository.get("job", job_id, Job)
        try:

            def fill(consultation: Consultation) -> None:
                consultation.transcript = demo_transcript()
                consultation.fields = demo_fields()
                consultation.source = "demo"
                consultation.language = "ru"
                consultation.revision += 1
                consultation.status = ConsultationStatus.REVIEW
                consultation.warnings = [
                    "Синтетический пример: аудио не распознавалось, LLM не вызывалась.",
                    "Диагноз и назначения не указаны в разговоре.",
                ]
                consultation.updated_at = utcnow()

            self.repository.mutate("consultation", job.consultation_id, Consultation, fill)

            def finish(current: Job) -> None:
                current.status = JobStatus.COMPLETED
                current.updated_at = utcnow()

            self.repository.mutate("job", job.id, Job, finish)
        except Exception:
            # No provider exception strings or transcript contents in public errors.
            def fail(current: Job) -> None:
                current.status = JobStatus.FAILED
                current.error = JobError(code="DEMO_FAILED", message="Не удалось загрузить пример.")
                current.updated_at = utcnow()

            self.repository.mutate("job", job.id, Job, fail)
            self.release(job.consultation_id)
