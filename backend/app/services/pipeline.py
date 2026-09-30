from pathlib import Path

from app.errors import AppError
from app.integrations.ports import PiiMasker, SpeechProvider, StructuringProvider
from app.schemas import ConsultationFields, Transcript


class Pipeline:
    """Integration seam. Routes will enqueue this after real providers are implemented."""

    def __init__(self, speech: SpeechProvider, pii: PiiMasker, llm: StructuringProvider):
        self.speech = speech
        self.pii = pii
        self.llm = llm

    async def process(self, audio: Path, language: str) -> tuple[Transcript, ConsultationFields]:
        transcript = await self.speech.transcribe(audio, language)
        masked = await self.pii.mask(transcript)
        if masked.needs_review:
            raise AppError(409, "PII_REVIEW_REQUIRED", "Проверьте маскирование перед вызовом LLM.")
        fields = await self.llm.extract(masked)
        return transcript, fields
