"""Bounded in-memory WAV fragments for the browser recorder."""

import asyncio
import io
import wave
from typing import Literal

from fastapi import APIRouter, Request

from app.errors import AppError
from app.integrations.speech_client import recognize
from app.workspace_api import store

router = APIRouter(prefix="/api/live", tags=["Live transcription"])
gate = asyncio.Semaphore(1)


@router.get("/capabilities")
def capabilities(request: Request):
    settings = request.app.state.settings
    return {
        "enabled": settings.demo_enabled,
        "speech": "configured_unverified" if settings.whisperx_base_url else "not_configured",
    }


@router.post("/transcribe")
async def transcribe(request: Request, language: Literal["ru", "kk", "auto"] = "auto"):
    store(request)
    settings = request.app.state.settings
    if not settings.whisperx_base_url:
        raise AppError(503, "SPEECH_UNAVAILABLE", "Распознавание не подключено.")
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > 1024 * 1024:
            raise AppError(413, "CHUNK_TOO_LARGE", "Фрагмент записи превышает 1 МБ.")
        content.extend(chunk)
    try:
        with wave.open(io.BytesIO(content)) as wav:
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getframerate() != 16000
                or not 0 < wav.getnframes() <= 16000 * 30
            ):
                raise ValueError()
    except (wave.Error, EOFError, ValueError):
        raise AppError(422, "INVALID_WAV", "Нужен WAV PCM16, 16 кГц, моно, до 30 секунд.") from None
    if gate.locked():
        raise AppError(429, "SPEECH_BUSY", "Другой фрагмент ещё распознаётся. Повторите попытку.")
    async with gate:
        try:
            return await recognize(settings, bytes(content), language)
        except Exception:
            raise AppError(
                503, "SPEECH_FAILED", "Распознавание не завершилось. Повторите фрагмент."
            ) from None
