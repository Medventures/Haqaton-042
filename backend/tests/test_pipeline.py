import asyncio
from pathlib import Path

import pytest

from app.errors import AppError
from app.integrations.ports import MaskedTranscript
from app.schemas import ConsultationFields, Segment, Transcript
from app.services.pipeline import Pipeline


@pytest.mark.parametrize("needs_review", [True, False])
def test_only_masked_and_reviewed_text_can_reach_llm(needs_review):
    seen = []

    class Speech:
        async def transcribe(self, audio, language):
            return Transcript(
                segments=[Segment(id="s1", start=0, end=1, text="PRIVATE_NAME: кашель")]
            )

    class Masker:
        async def mask(self, transcript):
            return MaskedTranscript(
                needs_review=needs_review,
                transcript=Transcript(
                    segments=[Segment(id="s1", start=0, end=1, text="[PATIENT]: кашель")]
                ),
            )

    class Llm:
        async def extract(self, transcript):
            seen.append(transcript)
            return ConsultationFields(complaints="Кашель")

    pipeline = Pipeline(Speech(), Masker(), Llm())
    if needs_review:
        with pytest.raises(AppError) as error:
            asyncio.run(pipeline.process(Path("synthetic.wav"), "ru"))
        assert error.value.code == "PII_REVIEW_REQUIRED"
        assert seen == []
    else:
        _, fields = asyncio.run(pipeline.process(Path("synthetic.wav"), "ru"))
        assert fields.complaints == "Кашель"
        assert "PRIVATE_NAME" not in seen[0].model_dump_json()
