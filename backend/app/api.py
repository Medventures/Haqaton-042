from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile

from app.errors import AppError, ErrorResponse
from app.schemas import (
    Consultation,
    CreateConsultation,
    ExportReceipt,
    Health,
    Job,
    RevisionRequest,
    UpdateConsultation,
)
from app.services.workflow import Workflow, check_editable, check_revision

ERROR_RESPONSES = {status: {"model": ErrorResponse} for status in (403, 404, 409, 422, 503)}
router = APIRouter(prefix="/api", responses=ERROR_RESPONSES)


def workflow(request: Request) -> Workflow:
    return request.app.state.workflow


WorkflowDep = Annotated[Workflow, Depends(workflow)]


@router.get("/health", response_model=Health, tags=["system"])
def health(request: Request) -> Health:
    settings = request.app.state.settings
    demo = settings.demo_enabled
    return Health(
        demo_enabled=demo,
        mis="mock_local" if demo else "not_configured",
        speech="configured_unverified" if settings.whisperx_base_url else "not_configured",
        llm="configured_unverified"
        if settings.openai_api_key.get_secret_value()
        else "not_configured",
    )


@router.post("/consultations", response_model=Consultation, status_code=201, tags=["consultations"])
def create_consultation(body: CreateConsultation, service: WorkflowDep) -> Consultation:
    return service.create(body)


@router.get("/consultations/{consultation_id}", response_model=Consultation, tags=["consultations"])
def get_consultation(consultation_id: UUID, service: WorkflowDep) -> Consultation:
    return service.get(consultation_id)


@router.patch(
    "/consultations/{consultation_id}", response_model=Consultation, tags=["consultations"]
)
def update_consultation(
    consultation_id: UUID,
    body: UpdateConsultation,
    service: WorkflowDep,
) -> Consultation:
    return service.update(consultation_id, body)


@router.post(
    "/consultations/{consultation_id}/confirm", response_model=Consultation, tags=["consultations"]
)
def confirm_consultation(
    consultation_id: UUID,
    body: RevisionRequest,
    service: WorkflowDep,
) -> Consultation:
    return service.confirm(consultation_id, body.expected_revision)


@router.post("/consultations/{consultation_id}/export", response_model=ExportReceipt, tags=["mis"])
def export_consultation(
    consultation_id: UUID,
    body: RevisionRequest,
    request: Request,
    service: WorkflowDep,
) -> ExportReceipt:
    if not request.app.state.settings.demo_enabled:
        raise AppError(503, "MIS_NOT_CONFIGURED", "МИС ещё не подключена.")
    return service.mock_export(consultation_id, body.expected_revision)


@router.post(
    "/consultations/{consultation_id}/demo",
    response_model=Job,
    status_code=202,
    tags=["demo"],
    summary="Загрузить синтетический пример без обработки аудио",
)
def load_demo(
    consultation_id: UUID,
    body: RevisionRequest,
    request: Request,
    tasks: BackgroundTasks,
) -> Job:
    if not request.app.state.settings.demo_enabled:
        raise AppError(403, "DEMO_DISABLED", "Деморежим выключен.")
    demo = request.app.state.demo
    job = demo.enqueue(consultation_id, body.expected_revision)
    tasks.add_task(demo.run, job.id)
    return job


@router.post(
    "/consultations/{consultation_id}/audio",
    response_model=Job,
    status_code=202,
    tags=["audio"],
    summary="Контракт загрузки аудио; пока возвращает 503",
)
async def upload_audio(
    consultation_id: UUID,
    service: WorkflowDep,
    file: Annotated[UploadFile, File(description="WAV, WebM, MP3; интеграция пока не реализована")],
    expected_revision: Annotated[int, Form(ge=1)],
) -> Job:
    try:
        consultation = service.get(consultation_id)
        check_revision(consultation, expected_revision)
        check_editable(consultation)
        raise AppError(503, "WHISPERX_NOT_CONFIGURED", "Распознавание ещё не подключено.")
    finally:
        await file.close()


@router.get("/jobs/{job_id}", response_model=Job, tags=["jobs"])
def get_job(job_id: UUID, request: Request) -> Job:
    return request.app.state.repository.get("job", job_id, Job)
