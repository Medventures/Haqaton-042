import io
import wave
from datetime import timedelta
from uuid import UUID

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import utcnow
from app.services.document_context import apply_document_selection
from app.workspace_models import Record, SpeechResult, Utterance, Workspace


def test_document_only_uses_supported_current_statements():
    record = Record(
        title="Current",
        kind="current",
        segments=[
            Utterance(role="patient", text="Не принимаю железо."),
            Utterance(role="unknown", text="Аллергии нет."),
            Utterance(role="doctor", text="План обследования: общий анализ крови."),
        ],
    )
    history = Record(
        title="History",
        kind="history",
        segments=[Utterance(role="doctor", text="Рекомендован контроль ОАК.")],
    )
    ws = Workspace(expires_at=utcnow() + timedelta(hours=1), records=[record, history])
    lookup = {str(i): (record, s) for i, s in enumerate(record.segments)}
    lookup["h"] = (history, history.segments[0])
    result = apply_document_selection(
        ws,
        lookup,
        {
            "assignments": [
                {"segment_id": "0", "field": "life_history", "quote": "принимаю железо."},
                {"segment_id": "0", "field": "treatment", "quote": "Не принимаю железо."},
                {"segment_id": "1", "field": "allergies", "quote": "Аллергии нет."},
                {"segment_id": "2", "field": "examination_plan", "quote": "общий анализ крови."},
                {"segment_id": "2", "field": "diagnosis", "quote": "Анемия"},
                {"segment_id": "h", "field": "recommendations", "quote": history.segments[0].text},
            ],
            "relevant_history": ["h"],
            "historical_recommendations": ["h"],
        },
        "",
    )
    assert result.document_fields["life_history"] == "Не принимаю железо."
    assert not result.document_fields["diagnosis"]
    assert not result.document_fields["treatment"]
    assert not result.document_fields["allergies"]
    assert not result.document_fields["recommendations"]
    assert result.document_fields["examination_plan"] == "общий анализ крови."
    assert len(result.previous_recommendations) == 1
    assert len(result.review_notes) == 2


def test_live_wav_contract_and_uuid(tmp_path, monkeypatch):
    async def speech(settings, audio, language):
        assert language == "kk" and audio.startswith(b"RIFF")
        return SpeechResult(language="kk", segments=[Utterance(text="Басым ауырады.")])

    monkeypatch.setattr("app.live_api.recognize", speech)
    with TestClient(
        create_app(
            Settings(
                _env_file=None,
                data_dir=tmp_path,
                demo_enabled=True,
                whisperx_base_url="http://speech",
            )
        )
    ) as c:
        assert c.post("/api/live/transcribe", content=b"bad").status_code == 422
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\0" * 3200)
        r = c.post("/api/live/transcribe?language=kk", content=b.getvalue())
        assert r.status_code == 200
        assert UUID(r.json()["segments"][0]["id"])
        assert (
            c.post("/api/live/transcribe?language=invalid", content=b.getvalue()).status_code == 422
        )
