from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient as RealAsyncClient

from app.config import Settings
from app.main import create_app
from app.mock_mis import create_mock_mis

KEY = "test-mis-secret-only-for-unit-tests"


@pytest.fixture
def integration(tmp_path, monkeypatch):
    mis = create_mock_mis(api_key=KEY, database_url="", path=tmp_path / "receiver.sqlite3")
    with TestClient(mis) as receiver:
        real_client = httpx.AsyncClient

        def forward(request):
            response = receiver.request(
                request.method,
                request.url.path,
                headers=dict(request.headers),
                content=request.content,
            )
            return httpx.Response(response.status_code, content=response.content)

        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda **kw: real_client(**kw, transport=httpx.MockTransport(forward)),
        )
        settings = Settings(
            _env_file=None,
            data_dir=tmp_path / "backend",
            demo_enabled=True,
            mis_base_url="http://mock-mis",
            MIS_API_KEY=KEY,
        )
        with TestClient(create_app(settings)) as backend:
            yield backend, receiver, tmp_path


def confirmed(backend):
    w = backend.post("/api/workspaces").json()
    base = f"/api/workspaces/{w['id']}"
    w = backend.patch(
        base + "/form",
        json={"expected_revision": 1, "fields": {"complaints": "Учебная запись: слабость."}},
    ).json()
    backend.post(base + "/confirm", json={"expected_revision": w["revision"]}).raise_for_status()
    return w, base


def export_body(w, patient="demo-patient-001"):
    return {
        "expected_revision": w["revision"],
        "patient_id": patient,
        "synthetic_data_confirmed": True,
    }


def test_real_receiver_auth_and_no_secret_in_settings(integration):
    backend, receiver, _ = integration
    for key in ("", "wrong"):
        assert receiver.get("/patients", headers={"X-API-Key": key}).status_code == 401
    assert len(receiver.get("/patients", headers={"X-API-Key": KEY}).json()) == 2
    result = backend.post("/api/integrations/mis/check")
    assert result.json()["status"] == "connected"
    response = backend.get("/api/integrations/mis/settings")
    assert KEY not in response.text and response.headers["cache-control"] == "no-store"
    backend.app.state.settings.mis_api_key = type(backend.app.state.settings.mis_api_key)(
        "incorrect"
    )
    assert backend.post("/api/integrations/mis/check").json()["error"]["code"] == "MIS_KEY_REJECTED"


def test_send_persist_read_repeat_and_changed_patient(integration):
    backend, receiver, root = integration
    w, base = confirmed(backend)
    first = backend.post(base + "/mis-export", json=export_body(w))
    assert first.status_code == 200
    receipt = first.json()
    assert receipt["superseded"] is False
    second = backend.post(base + "/mis-export", json=export_body(w))
    assert second.json()["document_id"] == receipt["document_id"]
    assert (
        backend.post(base + "/mis-export", json=export_body(w, "demo-patient-002")).status_code
        == 409
    )
    with TestClient(
        create_mock_mis(api_key=KEY, database_url="", path=root / "receiver.sqlite3")
    ) as restarted:
        stored = restarted.get(
            "/documents/" + receipt["document_id"], headers={"X-API-Key": KEY}
        ).json()
        assert stored["document"]["fields"] == w["fields"]
        assert "records" not in stored["document"] and "audio" not in stored["document"]
    with receiver.app.state.database.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM demo_documents").fetchone()[0] == 1


def test_confirmation_and_revision_are_required(integration):
    backend, _, _ = integration
    w, base = confirmed(backend)
    w = backend.patch(
        base + "/form",
        json={"expected_revision": w["revision"], "fields": {"complaints": "Проверенная правка"}},
    ).json()
    assert backend.post(base + "/mis-export", json=export_body(w)).status_code == 409
    backend.post(base + "/confirm", json={"expected_revision": w["revision"]})
    body = export_body(w)
    body["synthetic_data_confirmed"] = False
    assert backend.post(base + "/mis-export", json=body).status_code == 422
    body = export_body(w)
    body["expected_revision"] -= 1
    assert backend.post(base + "/mis-export", json=body).status_code == 409


def test_timeout_never_reports_success(integration, monkeypatch):
    backend, _, _ = integration

    def timed_out(request):
        raise httpx.ReadTimeout("Timeout", request=request)

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: RealAsyncClient(**kw, transport=httpx.MockTransport(timed_out)),
    )
    w, base = confirmed(backend)
    result = backend.post(base + "/mis-export", json=export_body(w))
    assert result.status_code == 504 and "document_id" not in result.text


def test_edit_during_request_marks_old_receipt(integration, monkeypatch):
    backend, _, _ = integration
    from app import mis_api

    send = mis_api.send_document

    async def editing(settings, document):
        result = await send(settings, document)
        store = backend.app.state.workspaces
        with store.lock:
            store.changed(store.items[document.consultation_id])
        return result

    monkeypatch.setattr(mis_api, "send_document", editing)
    w, base = confirmed(backend)
    result = backend.post(base + "/mis-export", json=export_body(w)).json()
    assert result["superseded"] is True and result["current_revision"] == w["revision"] + 1


def test_empty_and_conflicting_payload_rejected(integration):
    _, receiver, _ = integration
    identifier = str(uuid4())
    headers = {"X-API-Key": KEY, "Idempotency-Key": identifier + ":1"}
    body = {
        "consultation_id": identifier,
        "revision": 1,
        "patient_id": "demo-patient-001",
        "fields": {},
        "synthetic_data_confirmed": True,
    }
    assert receiver.post("/documents", headers=headers, json=body).status_code == 422
    body["fields"] = {"complaints": "Тест"}
    assert receiver.post("/documents", headers=headers, json=body).status_code == 200
    body["fields"] = {"complaints": "Изменённый текст"}
    assert receiver.post("/documents", headers=headers, json=body).status_code == 409
