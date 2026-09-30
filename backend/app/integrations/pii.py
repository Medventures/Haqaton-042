from app.errors import AppError
from app.integrations.ports import MaskedTranscript
from app.schemas import Transcript


class PersonalDataMasker:
    async def mask(self, transcript: Transcript) -> MaskedTranscript:
        # Fail closed until names, IIN, contacts and residual-PII review are implemented.
        raise AppError(
            503, "PII_NOT_IMPLEMENTED", "Маскирование персональных данных не реализовано."
        )
