from pathlib import Path

from app.errors import AppError
from app.schemas import Transcript
from app.config import Settings
from app.integrations.speech_client import recognize


class WhisperXProvider:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()

    async def transcribe(self, audio: Path, language: str) -> Transcript:
        if not self.settings.whisperx_base_url:
            raise AppError(503, "WHISPERX_NOT_CONFIGURED", "Сервис WhisperX ещё не подключён.")
        result = await recognize(self.settings, audio.read_bytes(), language)
        return Transcript(language=result.language, segments=[
            {'id': str(segment.id), 'start': segment.start, 'end': segment.end,
             'text': segment.text, 'speaker': 'unknown'} for segment in result.segments
        ])
