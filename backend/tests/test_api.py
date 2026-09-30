from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import Consultation, ConsultationStatus, Job, JobStatus


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path, demo_enabled=True))) as client:
        yield client


def create(client):
    response = client.post("/api/consultations", json={"patient_id": "demo-patient-001"})
    assert response.status_code == 201
    return response.json()


def demo(client, consultation):
    response = client.post(
        f"/api/consultations/{consultation['id']}/demo",
        json={"expected_revision": consultation["revision"]},
    )
    assert response.status_code == 202
    job = client.get(f"/api/jobs/{response.json()['id']}").json()
    assert job["status"] == "completed"
    assert job["mode"] == "demo"
    return client.get(f"/api/consultations/{consultation['id']}").json()


def test_full_review_flow_and_export_idempotency(client):
    consultation = demo(client, create(client))
    url = f"/api/consultations/{consultation['id']}"
    assert consultation["source"] == "demo"
    assert consultation["fields"]["diagnosis"] is None
    assert consultation["fields"]["prescriptions"] is None
    assert consultation["warnings"]
    revision = {"expected_revision": consultation["revision"]}
    assert client.post(f"{url}/export", json=revision).status_code == 409
    fields = consultation["fields"] | {"complaints": "Правка врача"}
    updated = client.patch(url, json=revision | {"fields": fields}).json()
    revision = {"expected_revision": updated["revision"]}
    assert client.post(f"{url}/confirm", json=revision).json()["status"] == "confirmed"
    receipt = client.post(f"{url}/export", json=revision)
    assert receipt.status_code == 200
    assert receipt.json()["mode"] == "mock"
    assert receipt.json()["patient_id"] == "demo-patient-001"
    assert client.post(f"{url}/export", json=revision).json() == receipt.json()
    assert client.get(url).json()["fields"]["complaints"] == "Правка врача"


def test_edit_invalidates_confirmation_and_stale_writes(client):
    consultation = demo(client, create(client))
    url = f"/api/consultations/{consultation['id']}"
    revision = {"expected_revision": consultation["revision"]}
    client.post(f"{url}/confirm", json=revision)
    client.post(f"{url}/export", json=revision)
    changed = client.patch(url, json=revision | {"fields": {"complaints": "Изменено"}}).json()
    assert changed["confirmed_revision"] is None
    assert changed["export_receipt"] is None
    assert changed["status"] == "review"
    stale = client.patch(url, json=revision | {"fields": {"complaints": "Старая правка"}})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "REVISION_CONFLICT"
    assert (
        client.post(f"{url}/export", json={"expected_revision": changed["revision"]}).json()[
            "error"
        ]["code"]
        == "CONFIRMATION_REQUIRED"
    )


def test_empty_form_cannot_be_confirmed(client):
    consultation = create(client)
    response = client.post(
        f"/api/consultations/{consultation['id']}/confirm", json={"expected_revision": 1}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMPTY_CONSULTATION"


def test_demo_cannot_overwrite_doctor_edits(client):
    consultation = demo(client, create(client))
    response = client.post(
        f"/api/consultations/{consultation['id']}/demo",
        json={"expected_revision": consultation["revision"]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "DEMO_REQUIRES_EMPTY_DRAFT"


def test_unconfigured_audio_never_returns_demo(client):
    consultation = create(client)
    response = client.post(
        f"/api/consultations/{consultation['id']}/audio",
        files={"file": ("test.webm", b"synthetic-file", "audio/webm")},
        data={"expected_revision": "1"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "WHISPERX_NOT_CONFIGURED"
    saved = client.get(f"/api/consultations/{consultation['id']}").json()
    assert saved["status"] == "draft"
    assert saved["transcript"]["segments"] == []


def test_demo_disabled_by_default(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path, demo_enabled=False))) as client:
        consultation = create(client)
        base = f"/api/consultations/{consultation['id']}"
        assert client.post(f"{base}/demo", json={"expected_revision": 1}).status_code == 403
        assert client.post(f"{base}/export", json={"expected_revision": 1}).status_code == 503
        health = client.get("/api/health").json()
        assert health["speech"] == health["llm"] == "not_configured"


def test_validation_does_not_echo_patient_data(client):
    response = client.post(
        "/api/consultations",
        json={"patient_id": "demo-patient", "unknown_field": "PRIVATE_PATIENT_DATA"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "PRIVATE_PATIENT_DATA" not in response.text
    assert client.get("/api/consultations/not-a-uuid").status_code == 422
    assert client.get("/api/consultations/00000000-0000-0000-0000-000000000000").status_code == 404


def test_cors_allows_only_configured_origins(client):
    headers = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"}
    allowed = client.options("/api/consultations", headers=headers)
    assert allowed.headers["access-control-allow-origin"] == headers["Origin"]
    denied = client.options(
        "/api/consultations", headers=headers | {"Origin": "https://other.test"}
    )
    assert "access-control-allow-origin" not in denied.headers


def test_data_survives_restart_and_pending_jobs_fail_explicitly(tmp_path):
    settings = Settings(data_dir=tmp_path, demo_enabled=True)
    app = create_app(settings)
    with TestClient(app) as client:
        completed = demo(client, create(client))
        pending = create(client)
        job = app.state.demo.enqueue(pending["id"], 1)
    second_app = create_app(settings)
    with TestClient(second_app) as client:
        saved = client.get(f"/api/consultations/{completed['id']}").json()
        assert saved["fields"] == completed["fields"]
        interrupted = second_app.state.repository.get("job", job.id, Job)
        assert interrupted.status == JobStatus.FAILED
        assert interrupted.error.code == "PROCESSING_INTERRUPTED"
        recovered = second_app.state.repository.get(
            "consultation", job.consultation_id, Consultation
        )
        assert recovered.status == ConsultationStatus.DRAFT


def test_openapi_matches_committed_contract(client):
    import json

    contract = Path(__file__).resolve().parents[2] / "contracts" / "openapi.json"
    assert client.get("/openapi.json").json() == json.loads(contract.read_text(encoding="utf-8"))
