from pathlib import Path
from typing import Protocol

from pydantic import Field

from app.schemas import Consultation, ConsultationFields, Schema, Transcript


class MaskedTranscript(Schema):
    transcript: Transcript
    needs_review: bool = True
    warnings: list[str] = Field(default_factory=list)


class SpeechProvider(Protocol):
    async def transcribe(self, audio: Path, language: str) -> Transcript: ...


class PiiMasker(Protocol):
    async def mask(self, transcript: Transcript) -> MaskedTranscript: ...


class StructuringProvider(Protocol):
    async def extract(self, transcript: MaskedTranscript) -> ConsultationFields: ...


class MisProvider(Protocol):
    async def export(self, consultation: Consultation, idempotency_key: str) -> str: ...
