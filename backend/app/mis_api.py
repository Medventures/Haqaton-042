from uuid import UUID

from fastapi import APIRouter, Request

from app.errors import AppError
from app.integrations.mis import mis_request, send_document
from app.mis_models import MisDocument, MisExportRequest, MisExportResult
from app.workspace_api import store

router = APIRouter(prefix="/api", tags=["Test MIS integration"])


@router.get("/integrations/mis/settings")
def settings(request: Request):
    store(request)
    config = request.app.state.settings
    return {
        "mode": "test_mis",
        "synthetic_only": True,
        "configured": bool(config.mis_base_url and config.mis_api_key.get_secret_value()),
        "api_key_configured": bool(config.mis_api_key.get_secret_value()),
        "destination": config.mis_base_url,
        "workspace_storage": "postgresql"
        if config.database_url and config.persist_workspaces
        else "memory",
        "speech_cache_enabled": config.speech_cache_enabled,
        "ttl_seconds": config.workspace_ttl_seconds,
        "notice": "Тестовая МИС сохраняет отправленный бланк. "
        "Используйте только вымышленные данные. "
        "Ключ находится на сервере. OpenAI и Hugging Face используют другие ключи.",
    }


@router.post("/integrations/mis/check")
async def check(request: Request):
    store(request)
    patients = await mis_request(request.app.state.settings, "GET", "/patients")
    if not isinstance(patients, list) or {p.get("id") for p in patients if isinstance(p, dict)} != {
        "demo-patient-001",
        "demo-patient-002",
    }:
        raise AppError(502, "MIS_INVALID_RESPONSE", "Ответ не соответствует тестовой МИС.")
    return {"status": "connected", "mode": "test_mis", "patients": patients}


@router.get("/integrations/mis/documents/{identifier}")
async def received_document(identifier: UUID, request: Request):
    store(request)
    return await mis_request(request.app.state.settings, "GET", f"/documents/{identifier}")


@router.post("/workspaces/{workspace_id}/mis-export", response_model=MisExportResult)
async def export(workspace_id: UUID, body: MisExportRequest, request: Request):
    data = store(request)
    if not body.synthetic_data_confirmed:
        raise AppError(
            422, "SYNTHETIC_ONLY", "Подтвердите, что отправляете только вымышленные данные."
        )
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        if workspace.confirmed_revision != workspace.revision:
            raise AppError(
                409, "CONFIRMATION_REQUIRED", "Проверьте и подтвердите текущую версию бланка."
            )
        document = MisDocument(
            consultation_id=workspace.id,
            revision=workspace.revision,
            patient_id=body.patient_id,
            fields=workspace.fields.model_copy(deep=True),
            document_fields=workspace.document_fields.copy(),
            synthetic_data_confirmed=True,
        )
    receipt = await send_document(request.app.state.settings, document)
    with data.lock:
        data.purge()
        current = data.items.get(workspace_id)
        revision = current.revision if current else None
        superseded = (
            current is None
            or current.revision != document.revision
            or current.confirmed_revision != document.revision
        )
    return MisExportResult(**receipt.model_dump(), current_revision=revision, superseded=superseded)
