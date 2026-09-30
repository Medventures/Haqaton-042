from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
FieldText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]


def utcnow() -> datetime:
    return datetime.now(UTC)


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConsultationStatus(StrEnum):
    DRAFT = "draft"
    PROCESSING = "processing"
    REVIEW = "review"
    CONFIRMED = "confirmed"
    EXPORTED = "exported"


class JobStatus(StrEnum):
    QUEUED = "queued"
    TRANSCRIBING = "transcribing"
    MASKING = "masking"
    STRUCTURING = "structuring"
    COMPLETED = "completed"
    FAILED = "failed"


class ConsultationFields(Schema):
    """Six editable text areas. Missing information is null, never an invented fact."""

    complaints: FieldText | None = None
    anamnesis: FieldText | None = None
    allergies: FieldText | None = None
    diagnosis: FieldText | None = None
    prescriptions: FieldText | None = None
    recommendations: FieldText | None = None


class Segment(Schema):
    id: ShortText
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    speaker: Literal["doctor", "patient", "unknown"] = "unknown"
    text: FieldText

    @model_validator(mode="after")
    def valid_time(self) -> "Segment":
        if self.end < self.start:
            raise ValueError("end must be greater than or equal to start")
        return self


class Transcript(Schema):
    language: Literal["ru", "kk", "mixed", "unknown"] = "unknown"
    segments: list[Segment] = Field(default_factory=list, max_length=2000)


class CreateConsultation(Schema):
    patient_id: ShortText
    language: Literal["ru", "kk", "auto"] = "ru"


class RevisionRequest(Schema):
    expected_revision: int = Field(ge=1)


class UpdateConsultation(RevisionRequest):
    # A full replacement of all six fields avoids ambiguous partial-null updates.
    fields: ConsultationFields


class ExportReceipt(Schema):
    mode: Literal["mock"] = "mock"
    consultation_id: UUID
    patient_id: str
    revision: int
    external_id: str
    exported_at: datetime


class Consultation(Schema):
    id: UUID
    patient_id: str
    language: Literal["ru", "kk", "auto"]
    status: ConsultationStatus = ConsultationStatus.DRAFT
    revision: int = 1
    confirmed_revision: int | None = None
    source: Literal["manual", "demo", "audio"] = "manual"
    fields: ConsultationFields = Field(default_factory=ConsultationFields)
    transcript: Transcript = Field(default_factory=Transcript)
    warnings: list[str] = Field(default_factory=list)
    export_receipt: ExportReceipt | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class JobError(Schema):
    code: str
    message: str


class Job(Schema):
    id: UUID
    consultation_id: UUID
    status: JobStatus = JobStatus.QUEUED
    mode: Literal["demo", "live"]
    error: JobError | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Health(Schema):
    status: Literal["ok"] = "ok"
    version: str = "0.1.0"
    demo_enabled: bool
    speech: Literal["not_configured", "configured_unverified"] = "not_configured"
    llm: Literal["not_configured", "configured_unverified"] = "not_configured"
    pii: Literal["not_implemented"] = "not_implemented"
    mis: Literal["mock_local", "not_configured"]
