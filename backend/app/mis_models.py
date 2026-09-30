from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field

from app.schemas import ConsultationFields, RevisionRequest, Schema

DemoPatientId = Literal["demo-patient-001", "demo-patient-002"]


class MisExportRequest(RevisionRequest):
    patient_id: DemoPatientId
    synthetic_data_confirmed: bool = False


class MisDocument(Schema):
    consultation_id: UUID
    revision: int = Field(ge=1)
    patient_id: DemoPatientId
    fields: ConsultationFields
    document_fields: dict[str, str] = Field(default_factory=dict)
    synthetic_data_confirmed: Literal[True]


class MisReceipt(Schema):
    mode: Literal["test_mis"] = "test_mis"
    document_id: UUID
    consultation_id: UUID
    revision: int
    patient_id: DemoPatientId
    received_at: datetime


class MisExportResult(MisReceipt):
    current_revision: int | None
    superseded: bool
