from datetime import date, datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import ConfigDict, Field, model_validator

from app.schemas import ConsultationFields, FieldText, RevisionRequest, Schema, ShortText
from app.services.calculations import CalculationResult


class Utterance(Schema):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
    id: UUID = Field(default_factory=uuid4)
    start: float = Field(default=0, ge=0)
    end: float = Field(default=0, ge=0)
    speaker_id: ShortText | None = None
    role: Literal["doctor", "patient", "unknown"] = "unknown"
    text: FieldText

    @model_validator(mode="after")
    def validate_time(self):
        if self.end < self.start:
            raise ValueError("end must be >= start")
        return self


class SpeechResult(Schema):
    language: str
    segments: list[Utterance] = Field(min_length=1, max_length=1500)


class RecordInput(Schema):
    title: ShortText
    visit_date: date | None = None
    kind: Literal["history", "current"]
    segments: list[Utterance] = Field(min_length=1, max_length=1500)

    @model_validator(mode="after")
    def check_segments(self):
        if sum(len(s.text) for s in self.segments) > 100000:
            raise ValueError("Transcript too long")
        if len({s.id for s in self.segments}) != len(self.segments):
            raise ValueError("Duplicate segment ids")
        return self


class Record(RecordInput):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
    id: UUID = Field(default_factory=uuid4)
    origin: Literal["audio", "text", "example"] = "text"


class AddRecord(RecordInput, RevisionRequest):
    pass


class Evidence(Schema):
    record_id: UUID
    segment_id: UUID
    quote: str
    reason: str


class FieldSource(Evidence):
    field: Literal[
        "complaints", "anamnesis", "allergies", "diagnosis", "prescriptions", "recommendations"
    ]


class Analyze(RevisionRequest):
    focus: str = Field(default="", max_length=1000)
    engine: Literal["local_rules", "openai"] = "local_rules"
    allow_cloud_processing: bool = False


class SaveForm(RevisionRequest):
    fields: ConsultationFields
    document_fields: dict[str, str] | None = None


class LoadCached(RevisionRequest):
    kind: Literal['history', 'current'] = 'current'
    title: ShortText = 'Сохранённая расшифровка'
    visit_date: date | None = None


class AudioJob(Schema):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
    id: UUID = Field(default_factory=uuid4)
    status: Literal["transcribing", "completed", "failed"] = "transcribing"
    title: str
    record_id: UUID | None = None
    error: str | None = None
    cache_hit: bool = False


class Workspace(Schema):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
    id: UUID = Field(default_factory=uuid4)
    revision: int = 1
    expires_at: datetime
    records: list[Record] = Field(default_factory=list)
    jobs: list[AudioJob] = Field(default_factory=list)
    focus: str = ""
    fields: ConsultationFields = Field(default_factory=ConsultationFields)
    evidence: list[Evidence] = Field(default_factory=list)
    field_sources: list[FieldSource] = Field(default_factory=list)
    previous_recommendations: list[Evidence] = Field(default_factory=list)
    generated: bool = False
    context_stale: bool = False
    confirmed_revision: int | None = None
    engine: Literal["local_rules", "openai"] = "local_rules"
    measurements: list[dict] = Field(default_factory=list)
    calculation: CalculationResult | None = None
    applied_calculation_text: str | None = None
    automatic_calculation: dict = Field(default_factory=dict)
    manually_edited_fields: list[str] = Field(default_factory=list)
    document_fields: dict[str, str] = Field(default_factory=dict)
    document_sources: dict[str, list[str]] = Field(default_factory=dict)
    review_notes: list[str] = Field(default_factory=list)
