from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, Request, Response

from app.errors import AppError, ErrorResponse
from app.schemas import RevisionRequest
from app.services.audio import transcribe_audio
from app.services.calculations import CalculationInput, calculate
from app.services.context import analyze_context
from app.services.llm_context import analyze_openai
from app.services.workspaces import WorkspaceStore
from app.workspace_models import AddRecord, Analyze, AudioJob, Record, SaveForm, Workspace, LoadCached
from app.services.speech_cache import SpeechCache
from app.services.document import FORM_TEMPLATE, docx_bytes
from app.config import Settings

router = APIRouter(
    prefix="/api/workspaces",
    tags=["Temporary demo workspace"],
    responses={code: {"model": ErrorResponse} for code in [403, 404, 409, 413, 422, 429, 503]},
)


def store(request: Request) -> WorkspaceStore:
    if not request.app.state.settings.demo_enabled:
        raise AppError(403, "DEMO_DISABLED", "Включите MEDHUB_DEMO_ENABLED для локального демо.")
    return request.app.state.workspaces


@router.get("/capabilities")
def capabilities(request: Request) -> dict:
    settings = request.app.state.settings
    return {
        "enabled": settings.demo_enabled,
        "speech": "configured_unverified" if settings.whisperx_base_url else "not_configured",
        "engine": "openai" if settings.openai_api_key.get_secret_value() else "local_rules",
        "cloud_llm": bool(settings.openai_api_key.get_secret_value()),
        "storage": "postgresql" if settings.database_url and settings.persist_workspaces else "memory",
        "ttl_seconds": settings.workspace_ttl_seconds,
        "max_audio_bytes": settings.max_audio_bytes,
        "openai_model": settings.openai_model,
        "openai_status": "configured_unverified" if settings.openai_api_key.get_secret_value() else "missing_key",
        "speech_cache_enabled": settings.speech_cache_enabled,
        "transcript_storage": 'postgresql' if settings.database_url else 'sqlite' if settings.speech_cache_enabled else 'disabled',
        "document_formats": ["docx", "json"],
    }


@router.post('/connection/reload')
def reload_connection(request: Request):
    store(request)
    config = Settings()
    request.app.state.settings.openai_api_key = config.openai_api_key
    request.app.state.settings.openai_model = config.openai_model
    return capabilities(request)


@router.get('/form-template')
def form_template(request: Request):
    store(request)
    return FORM_TEMPLATE


@router.get('/saved-transcripts')
def saved_transcripts(request: Request):
    store(request)
    return demo_library(request).list()


def demo_library(request: Request):
    settings = request.app.state.settings
    if settings.demo_library_enabled:
        settings = settings.model_copy(update={"speech_cache_enabled": True})
    return SpeechCache(settings)


@router.get('/saved-transcripts/{identifier}/audio')
def saved_audio(identifier: str, request: Request):
    store(request)
    content = demo_library(request).get_audio(identifier)
    if content is None:
        raise AppError(404, 'AUDIO_NOT_FOUND', 'Исходная запись не сохранена.')
    media = 'audio/mp4' if content[4:8] == b'ftyp' else 'audio/wav' if content[:4] == b'RIFF' else 'application/octet-stream'
    return Response(content, media_type=media)


@router.delete('/saved-transcripts/{identifier}', status_code=204)
def delete_saved_transcript(identifier: str, request: Request):
    store(request)
    demo_library(request).delete(identifier)
    return Response(status_code=204)


@router.post('/{workspace_id}/saved-transcripts/{identifier}', response_model=Workspace)
def load_transcript(workspace_id: UUID, identifier: str, body: LoadCached, request: Request):
    data = store(request)
    result = demo_library(request).get(identifier)
    if result is None:
        raise AppError(404, 'TRANSCRIPT_NOT_FOUND', 'Сохранённая расшифровка не найдена.')
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        data.add_record(workspace, Record(title=body.title, kind=body.kind,
                        visit_date=body.visit_date, origin='audio', segments=result.segments))
        return workspace.model_copy(deep=True)


@router.post('/{workspace_id}/document')
def download_document(workspace_id: UUID, body: RevisionRequest, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision).model_copy(deep=True)
    content = docx_bytes(workspace)
    return Response(content, media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    headers={'Content-Disposition': f'attachment; filename="consultation-v{workspace.revision}.docx"',
                             'X-Document-Revision': str(workspace.revision), 'X-Form-Template': FORM_TEMPLATE['id']})


@router.post("", response_model=Workspace, status_code=201)
def create(request: Request):
    return store(request).create()


@router.get("/{workspace_id}", response_model=Workspace)
def get(workspace_id: UUID, request: Request):
    return store(request).get(workspace_id)


@router.delete("/{workspace_id}", status_code=204)
def delete(workspace_id: UUID, request: Request):
    data = store(request)
    with data.lock:
        data.delete(workspace_id)
    return Response(status_code=204)


@router.post("/{workspace_id}/records", response_model=Workspace, status_code=201)
def add(workspace_id: UUID, body: AddRecord, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        data.add_record(workspace, Record(**body.model_dump(exclude={"expected_revision"})))
        return workspace.model_copy(deep=True)


@router.patch("/{workspace_id}/records/{record_id}", response_model=Workspace)
def edit_record(workspace_id: UUID, record_id: UUID, body: AddRecord, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        original = next((r for r in workspace.records if r.id == record_id), None)
        if not original:
            raise AppError(404, "RECORD_NOT_FOUND", "Запись не найдена.")
        if body.kind != original.kind:
            raise AppError(409, "RECORD_KIND", "Тип записи нельзя изменить после загрузки.")
        replacement = Record(
            **body.model_dump(exclude={"expected_revision"}), id=original.id, origin=original.origin
        )
        workspace.records[workspace.records.index(original)] = replacement
        data.changed(workspace, context_changed=True)
        return workspace.model_copy(deep=True)


@router.delete("/{workspace_id}/records/{record_id}", response_model=Workspace)
def delete_record(
    workspace_id: UUID, record_id: UUID, request: Request, expected_revision: int = Query(ge=1)
):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, expected_revision)
        if not any(r.id == record_id for r in workspace.records):
            raise AppError(404, "RECORD_NOT_FOUND", "Запись не найдена.")
        workspace.records = [r for r in workspace.records if r.id != record_id]
        data.changed(workspace, context_changed=True)
        return workspace.model_copy(deep=True)


@router.post("/{workspace_id}/analyze", response_model=Workspace)
async def analyze(workspace_id: UUID, body: Analyze, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        if not any(r.kind == "current" for r in workspace.records):
            raise AppError(409, "CURRENT_REQUIRED", "Добавьте запись текущего приёма.")
        snapshot = workspace.model_copy(deep=True)
    if body.engine == "openai":
        if not body.allow_cloud_processing:
            raise AppError(
                409, "CLOUD_REVIEW_REQUIRED", "Проверьте текст перед отправкой в OpenAI."
            )
        from app.services.document_context import analyze_document
        snapshot = await analyze_document(snapshot, body.focus, request.app.state.settings)
    else:
        analyze_context(snapshot, body.focus)
        snapshot.engine = "local_rules"
    with data.lock:
        data.editable(workspace_id, body.expected_revision)
        data.changed(snapshot)
        data.items[workspace_id] = snapshot
        return snapshot.model_copy(deep=True)


@router.patch("/{workspace_id}/form", response_model=Workspace)
def save_form(workspace_id: UUID, body: SaveForm, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        # A manually changed field no longer claims that its text is an exact source quote.
        changed = {
            key
            for key in type(body.fields).model_fields
            if getattr(workspace.fields, key) != getattr(body.fields, key)
        }
        workspace.field_sources = [s for s in workspace.field_sources if s.field not in changed]
        workspace.fields = body.fields
        if body.document_fields is not None:
            from app.services.document_context import FIELDS
            if set(body.document_fields) - set(FIELDS) or any(len(v) > 10000 for v in body.document_fields.values()):
                raise AppError(422, 'DOCUMENT_FIELDS_INVALID', 'Проверьте поля бланка.')
            workspace.document_fields = body.document_fields.copy()
            workspace.document_sources = {}
        workspace.manually_edited_fields = sorted(set(workspace.manually_edited_fields) | changed)
        data.changed(workspace)
        return workspace.model_copy(deep=True)


@router.post('/{workspace_id}/draft', response_model=Workspace)
def refresh_draft(workspace_id: UUID, body: RevisionRequest, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        previous = workspace.fields.model_copy(deep=True)
        analyze_context(workspace, workspace.focus)
        for field in workspace.manually_edited_fields:
            setattr(workspace.fields, field, getattr(previous, field))
        workspace.field_sources = [s for s in workspace.field_sources if s.field not in workspace.manually_edited_fields]
        workspace.engine = 'local_rules'
        data.changed(workspace)
        return workspace.model_copy(deep=True)


@router.post("/{workspace_id}/confirm", response_model=Workspace)
def confirm(workspace_id: UUID, body: RevisionRequest, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        if workspace.context_stale:
            raise AppError(409, "CONTEXT_STALE", "Источники изменились. Соберите форму заново.")
        if not any(workspace.fields.model_dump().values()):
            raise AppError(409, "EMPTY_FORM", "Заполните хотя бы одно поле.")
        workspace.confirmed_revision = workspace.revision
        data.persist(workspace)
        return workspace.model_copy(deep=True)


@router.post("/{workspace_id}/export")
def export(workspace_id: UUID, body: RevisionRequest, request: Request) -> dict:
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        if workspace.confirmed_revision != workspace.revision:
            raise AppError(409, "CONFIRMATION_REQUIRED", "Сначала проверьте и подтвердите форму.")
        return {
            "mode": "local_download",
            "workspace_id": str(workspace.id),
            "revision": workspace.revision,
            "fields": workspace.fields.model_dump(),
            "field_sources": [s.model_dump(mode="json") for s in workspace.field_sources],
            "calculation": workspace.calculation.model_dump() if workspace.calculation else None,
        }


@router.post("/{workspace_id}/calculate", response_model=Workspace)
def calculate_form(workspace_id: UUID, body: CalculationInput, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        workspace.calculation = calculate(body)
        data.changed(workspace)
        return workspace.model_copy(deep=True)


@router.post("/{workspace_id}/calculation/apply", response_model=Workspace)
def apply_calculation(workspace_id: UUID, body: RevisionRequest, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        result = workspace.calculation
        if not result or not result.reviewed:
            raise AppError(409, "CALCULATION_REVIEW", "Врач должен проверить параметры расчёта.")
        if result.exceeds_maximum:
            raise AppError(409, "DOSE_EXCEEDS_MAXIMUM", "Расчёт превышает указанный максимум.")
        if result.dose_mg is not None and result.maximum_mg is None:
            raise AppError(409, "DOSE_MAXIMUM_REQUIRED", "Укажите проверенную максимальную дозу.")
        previous = workspace.fields.recommendations or ""
        if workspace.applied_calculation_text and workspace.applied_calculation_text != result.text:
            previous = previous.replace(workspace.applied_calculation_text, "").strip()
        if result.text not in previous:
            combined = (previous + "\n\n" + result.text).strip()
            if len(combined) > 10000:
                raise AppError(409, "FIELD_TOO_LONG", "Недостаточно места в поле рекомендаций.")
            workspace.fields.recommendations = combined
            workspace.applied_calculation_text = result.text
            workspace.field_sources = [
                s for s in workspace.field_sources if s.field != "recommendations"
            ]
            data.changed(workspace)
        return workspace.model_copy(deep=True)


@router.post("/{workspace_id}/audio", response_model=AudioJob, status_code=202)
async def audio(
    workspace_id: UUID,
    request: Request,
    background: BackgroundTasks,
    title: Annotated[str, Query(min_length=1, max_length=200)],
    kind: Literal["history", "current"],
    expected_revision: Annotated[int, Query(ge=1)],
    visit_date: date | None = None,
    language: Literal["ru", "kk", "auto"] = "ru",
):
    """Raw audio body, limited before buffering; multipart spooling is not used."""
    data = store(request)
    settings = request.app.state.settings
    if not settings.whisperx_base_url:
        raise AppError(503, "WHISPERX_NOT_CONFIGURED", "WhisperX пока не подключён.")
    with data.lock:
        workspace = data.editable(workspace_id, expected_revision)
        data.check_record(workspace, kind)
        if sum(j.status == "transcribing" for w in data.items.values() for j in w.jobs) >= 2:
            raise AppError(429, "SPEECH_BUSY", "Сервис занят. Повторите загрузку позже.")
        job = AudioJob(title=title)
        workspace.jobs = workspace.jobs[-19:] + [job]
        data.changed(workspace)
    try:
        content = bytearray()
        async for chunk in request.stream():
            if len(content) + len(chunk) > settings.max_audio_bytes:
                raise AppError(413, "AUDIO_TOO_LARGE", "Максимальный размер аудио — 30 МБ.")
            content.extend(chunk)
        if not content:
            raise AppError(422, "EMPTY_AUDIO", "Аудиофайл пуст.")
        background.add_task(
            transcribe_audio,
            settings,
            data,
            workspace_id,
            job.id,
            bytes(content),
            title,
            kind,
            visit_date,
            language,
        )
    except BaseException:
        with data.lock:
            job.status = "failed"
            job.error = "Загрузка аудио не завершена."
        raise
    return job.model_copy(deep=True)


@router.post("/{workspace_id}/example", response_model=Workspace)
def example(workspace_id: UUID, body: RevisionRequest, request: Request):
    data = store(request)
    with data.lock:
        workspace = data.editable(workspace_id, body.expected_revision)
        if workspace.records or any(workspace.fields.model_dump().values()):
            raise AppError(409, "EXAMPLE_REQUIRES_EMPTY", "Пример доступен только в пустой сессии.")
        samples = [
            (
                "Предыдущий приём",
                "2026-08-10",
                "history",
                [
                    ("patient", "Раньше говорили об анемии. Беспокоит усталость."),
                    ("doctor", "В прошлой записи: гемоглобин 108 г/л, ферритин 9 нг/мл."),
                    ("doctor", "Рекомендую повторить анализ на ферритин перед следующим приёмом."),
                ],
            ),
            (
                "Приём по поводу простуды",
                "2026-09-02",
                "history",
                [
                    ("patient", "Жалобы: кашель и насморк в течение двух дней."),
                    ("doctor", "Рекомендации: повторный приём при ухудшении самочувствия."),
                ],
            ),
            (
                "Текущий приём",
                "2026-09-30",
                "current",
                [
                    ("patient", "Жалобы: снова ощущаю слабость и утомляемость."),
                    ("patient", "Хочу обсудить анемию и прошлые анализы на железо."),
                    ("patient", "Мой рост 170 см, вес 65 кг."),
                    ("patient", "В сегодняшнем анализе гемоглобин 112 г/л."),
                    (
                        "doctor",
                        "Для учебного расчёта: целевой гемоглобин 150 г/л, запас железа 500 мг.",
                    ),
                    ("doctor", "Рекомендации: принести результаты предыдущих анализов."),
                ],
            ),
        ]
        for title, day, kind, lines in samples:
            data.add_record(
                workspace,
                Record(
                    title=title,
                    visit_date=day,
                    kind=kind,
                    origin="example",
                    segments=[{"role": role, "text": text} for role, text in lines],
                ),
            )
        return workspace.model_copy(deep=True)
