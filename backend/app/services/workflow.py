from uuid import UUID, uuid4

from app.errors import AppError
from app.repository import Repository
from app.schemas import (
    Consultation,
    ConsultationStatus,
    CreateConsultation,
    ExportReceipt,
    UpdateConsultation,
    utcnow,
)


def check_revision(consultation: Consultation, expected: int) -> None:
    if consultation.revision != expected:
        raise AppError(409, "REVISION_CONFLICT", "Форма изменилась. Загрузите актуальную версию.")


def check_editable(consultation: Consultation) -> None:
    if consultation.status == ConsultationStatus.PROCESSING:
        raise AppError(409, "PROCESSING_IN_PROGRESS", "Дождитесь завершения обработки.")


class Workflow:
    def __init__(self, repository: Repository):
        self.repository = repository

    def create(self, request: CreateConsultation) -> Consultation:
        consultation = Consultation(id=uuid4(), **request.model_dump())
        self.repository.insert("consultation", consultation.id, consultation)
        return consultation

    def get(self, identifier: UUID) -> Consultation:
        return self.repository.get("consultation", identifier, Consultation)

    def update(self, identifier: UUID, request: UpdateConsultation) -> Consultation:
        def change(consultation: Consultation) -> None:
            check_revision(consultation, request.expected_revision)
            check_editable(consultation)
            consultation.fields = request.fields
            consultation.revision += 1
            consultation.confirmed_revision = None
            consultation.export_receipt = None
            consultation.status = ConsultationStatus.REVIEW
            consultation.updated_at = utcnow()

        return self.repository.mutate("consultation", identifier, Consultation, change)

    def confirm(self, identifier: UUID, expected_revision: int) -> Consultation:
        def change(consultation: Consultation) -> None:
            check_revision(consultation, expected_revision)
            check_editable(consultation)
            if not any(consultation.fields.model_dump().values()):
                raise AppError(409, "EMPTY_CONSULTATION", "Заполните хотя бы одно поле.")
            if consultation.confirmed_revision == consultation.revision:
                return
            consultation.confirmed_revision = consultation.revision
            consultation.status = ConsultationStatus.CONFIRMED
            consultation.updated_at = utcnow()

        return self.repository.mutate("consultation", identifier, Consultation, change)

    def mock_export(self, identifier: UUID, expected_revision: int) -> ExportReceipt:
        def change(consultation: Consultation) -> None:
            check_revision(consultation, expected_revision)
            check_editable(consultation)
            if consultation.confirmed_revision != consultation.revision:
                raise AppError(409, "CONFIRMATION_REQUIRED", "Сначала подтвердите текущую форму.")
            if consultation.export_receipt is None:
                consultation.export_receipt = ExportReceipt(
                    consultation_id=consultation.id,
                    patient_id=consultation.patient_id,
                    revision=consultation.revision,
                    external_id=f"mock-{consultation.id}-v{consultation.revision}",
                    exported_at=utcnow(),
                )
                consultation.status = ConsultationStatus.EXPORTED
                consultation.updated_at = utcnow()

        consultation = self.repository.mutate("consultation", identifier, Consultation, change)
        assert consultation.export_receipt is not None
        return consultation.export_receipt
