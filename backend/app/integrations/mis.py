import httpx

from app.config import Settings
from app.errors import AppError
from app.mis_models import MisDocument, MisReceipt


async def mis_request(settings: Settings, method: str, path: str, *, body=None, key=None):
    if not settings.mis_base_url or not settings.mis_api_key.get_secret_value():
        raise AppError(
            503,
            "MIS_NOT_CONFIGURED",
            "Добавьте адрес и отдельный API-ключ тестовой МИС на сервере.",
        )
    headers = {"X-API-Key": settings.mis_api_key.get_secret_value()}
    if key:
        headers["Idempotency-Key"] = key
    try:
        async with httpx.AsyncClient(
            timeout=settings.mis_timeout_seconds, follow_redirects=False
        ) as client:
            response = await client.request(
                method, settings.mis_base_url.rstrip("/") + path, headers=headers, json=body
            )
        if response.status_code in (401, 403):
            raise AppError(
                502,
                "MIS_KEY_REJECTED",
                "Тестовая МИС отклонила API-ключ. Проверьте серверные настройки.",
            )
        if response.status_code == 409:
            raise AppError(
                409, "MIS_CONFLICT", "Эта версия уже отправлена с другим содержимым или пациентом."
            )
        if response.status_code == 404:
            raise AppError(404, "MIS_NOT_FOUND", "Запись не найдена в тестовой МИС.")
        response.raise_for_status()
        return response.json()
    except httpx.TimeoutException:
        raise AppError(
            504,
            "MIS_TIMEOUT",
            "МИС не подтвердила отправку вовремя. Повторите ту же версию: дубликат не создастся.",
        ) from None
    except (httpx.HTTPError, ValueError):
        raise AppError(
            502,
            "MIS_UNAVAILABLE",
            "Не удалось получить подтверждение тестовой МИС. Успех не подтверждён.",
        ) from None


async def send_document(settings: Settings, document: MisDocument) -> MisReceipt:
    result = await mis_request(
        settings,
        "POST",
        "/documents",
        body=document.model_dump(mode="json"),
        key=f"{document.consultation_id}:{document.revision}",
    )
    try:
        receipt = MisReceipt.model_validate(result)
        if (receipt.consultation_id, receipt.revision, receipt.patient_id) != (
            document.consultation_id,
            document.revision,
            document.patient_id,
        ):
            raise ValueError("Mismatched receipt")
        return receipt
    except ValueError:
        raise AppError(
            502, "MIS_INVALID_RECEIPT", "МИС вернула некорректную квитанцию. Успех не подтверждён."
        ) from None
