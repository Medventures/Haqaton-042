from datetime import date
from uuid import UUID

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.integrations.speech_client import recognize
from app.workspace_models import Record, SpeechResult

from .workspaces import WorkspaceStore
from .speech_cache import SpeechCache


async def transcribe_audio(
    settings: Settings,
    store: WorkspaceStore,
    workspace_id: UUID,
    job_id: UUID,
    audio: bytes,
    title: str,
    kind: str,
    visit_date: date | None,
    language: str,
):
    try:
        cache = SpeechCache(settings)
        cache_key = cache.key(audio, language)
        result = cache.get(cache_key)
        cache_hit = result is not None
        if result is None:
            result = await recognize(settings, audio, language)
            cache.put(cache_key, title, language, result, audio)
        record = Record(
            title=title,
            kind=kind,
            visit_date=visit_date,
            origin="audio",
            segments=[
                segment.model_copy(update={"role": "unknown"}) for segment in result.segments
            ],
        )
        with store.lock:
            workspace = store.require(workspace_id)
            job = next(j for j in workspace.jobs if j.id == job_id)
            store.add_record(workspace, record)
            job.status = "completed"
            job.record_id = record.id
            job.cache_hit = cache_hit
            store.persist(workspace)
    except Exception as exc:
        if isinstance(exc, (ValueError, ValidationError)):
            message = "WhisperX вернул пустую или некорректную расшифровку."
        elif isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 401:
            message = "WhisperX отклонил ключ доступа. Проверьте настройки backend и worker."
        else:
            message = "Не удалось расшифровать аудио. Проверьте WhisperX и повторите загрузку."
        # Never expose upstream response bodies, transcripts, URLs or credentials.
        with store.lock:
            workspace = store.items.get(workspace_id)
            if workspace:
                job = next(j for j in workspace.jobs if j.id == job_id)
                job.status = "failed"
                job.error = message
                workspace.revision += 1
                store.persist(workspace)
    finally:
        audio = b""
