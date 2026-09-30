from app.errors import AppError
from app.integrations.ports import MaskedTranscript
from app.schemas import ConsultationFields


class OpenAIStructurer:
    async def extract(self, transcript: MaskedTranscript) -> ConsultationFields:
        # Next step: Responses API with Structured Outputs and server-side credentials.
        # Never accept an unmasked Transcript or send patient metadata to the provider.
        raise AppError(503, "OPENAI_NOT_CONFIGURED", "Интеграция с OpenAI ещё не подключена.")
