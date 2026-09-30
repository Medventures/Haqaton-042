from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import utcnow
from app.services.calculations import CalculationInput, calculate, find_measurements
from app.services.llm_context import apply_selection
from app.workspace_models import Record


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path, demo_enabled=True))
    with TestClient(app) as client:
        yield client


def start(client, example=True):
    response = client.post("/api/workspaces")
    assert response.status_code == 201
    workspace = response.json()
    if example:
        workspace = client.post(
            f"/api/workspaces/{workspace['id']}/example", json={"expected_revision": 1}
        ).json()
    return workspace


def post(client, workspace, action, **body):
    return client.post(
        f"/api/workspaces/{workspace['id']}/{action}",
        json={"expected_revision": workspace["revision"], **body},
    )


def test_history_retrieval_and_current_recommendations_remain_separate(client):
    workspace = start(client)
    result = post(client, workspace, "analyze", focus="анемия").json()
    assert result["engine"] == "local_rules"
    quotes = " ".join(e["quote"] for e in result["evidence"])
    assert "ферритин" in quotes and "кашель" not in quotes
    assert result["previous_recommendations"]
    assert "принести" in result["fields"]["recommendations"]
    assert "повторить" not in result["fields"]["recommendations"]
    assert result["fields"]["diagnosis"] is None
    assert result["fields"]["prescriptions"] is None
    assert post(client, result, "export").status_code == 409
    confirmed = post(client, result, "confirm").json()
    exported = post(client, confirmed, "export").json()
    assert exported["mode"] == "local_download"


def test_temporary_data_not_in_sqlite_and_deleted_on_restart(client):
    workspace = start(client)
    database = client.app.state.repository.path
    assert b"hemoglobin" not in database.read_bytes()
    with client.app.state.repository.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
    second = create_app(client.app.state.settings)
    with TestClient(second) as other:
        assert other.get(f"/api/workspaces/{workspace['id']}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace['id']}").headers["cache-control"] == "no-store"


def test_expiry_deletion_and_cross_session_isolation(client):
    first, second = start(client), start(client, False)
    assert second["records"] == []
    record = first["records"][0]
    assert (
        client.delete(
            f"/api/workspaces/{second['id']}/records/{record['id']}?expected_revision=1"
        ).status_code
        == 404
    )
    data = client.app.state.workspaces
    from uuid import UUID

    data.items[UUID(first["id"])].expires_at = utcnow() - timedelta(seconds=1)
    data.purge()
    assert client.get(f"/api/workspaces/{first['id']}").status_code == 404
    assert client.delete(f"/api/workspaces/{second['id']}").status_code == 204
    assert client.get(f"/api/workspaces/{second['id']}").status_code == 404


def test_changed_sources_preserve_edits_but_block_confirmation(client):
    workspace = post(client, start(client), "analyze", focus="анемия").json()
    url = f"/api/workspaces/{workspace['id']}"
    saved = client.patch(
        url + "/form",
        json={
            "expected_revision": workspace["revision"],
            "fields": {"recommendations": "Правка врача"},
        },
    ).json()
    assert post(client, workspace, "confirm").status_code == 409
    record = saved["records"][-1]
    record["segments"][0]["text"] = "Исправленная жалоба"
    changed = client.patch(
        url + f"/records/{record['id']}",
        json={
            **{k: v for k, v in record.items() if k not in {"id", "origin"}},
            "expected_revision": saved["revision"],
        },
    ).json()
    assert changed["fields"]["recommendations"] == "Правка врача"
    assert changed["context_stale"] and not changed["field_sources"]
    assert post(client, changed, "confirm").status_code == 409


def test_cloud_requires_explicit_text_review(client):
    workspace = start(client)
    response = post(client, workspace, "analyze", engine="openai")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CLOUD_REVIEW_REQUIRED"


def test_unconfigured_audio_has_no_synthetic_fallback(client):
    workspace = start(client, False)
    response = client.post(
        f"/api/workspaces/{workspace['id']}/audio",
        params={"title": "Audio", "kind": "current", "expected_revision": 1},
        content=b"audio",
    )
    assert response.status_code == 503
    assert client.get(f"/api/workspaces/{workspace['id']}").json()["records"] == []


def test_audio_integration_contract_and_unknown_roles(client, monkeypatch):
    workspace = start(client, False)
    client.app.state.settings.whisperx_base_url = "http://worker.test"
    real_client = httpx.AsyncClient

    def handle(request):
        assert request.content == b"test-audio"
        return httpx.Response(
            200,
            json={
                "language": "ru",
                "segments": [
                    {"text": "Мой рост 170 см", "start": 0, "end": 2, "role": "doctor"},
                ],
            },
        )

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **_: real_client(transport=httpx.MockTransport(handle))
    )
    response = client.post(
        f"/api/workspaces/{workspace['id']}/audio",
        params={"title": "Audio", "kind": "current", "expected_revision": 1},
        content=b"test-audio",
    )
    assert response.status_code == 202
    saved = client.get(f"/api/workspaces/{workspace['id']}").json()
    assert saved["jobs"][0]["status"] == "completed"
    assert saved["records"][0]["origin"] == "audio"
    assert saved["records"][0]["segments"][0]["role"] == "unknown"
    assert not saved["measurements"]


def test_audio_size_limit_releases_busy_slot(client):
    workspace = start(client, False)
    settings = client.app.state.settings
    settings.whisperx_base_url = "http://worker.test"
    settings.max_audio_bytes = 3
    response = client.post(
        f"/api/workspaces/{workspace['id']}/audio",
        params={"title": "Audio", "kind": "current", "expected_revision": 1},
        content=b"1234",
    )
    assert response.status_code == 413
    saved = client.get(f"/api/workspaces/{workspace['id']}").json()
    assert saved["jobs"][0]["status"] == "failed"
    assert not saved["records"]


def test_llm_cannot_invent_sources_or_promote_history(client):
    from uuid import UUID

    data = client.app.state.workspaces
    workspace = start(client)
    stored = data.get(UUID(workspace["id"]))
    history = stored.records[0]
    with pytest.raises(ValueError):
        apply_selection(
            stored,
            "",
            {"s0": (history, history.segments[1])},
            {
                "assignments": [{"segment_id": "s0", "field": "prescriptions"}],
                "relevant_history": [],
                "historical_recommendations": [],
            },
        )


def test_numeric_extraction_units_and_targets():
    record = Record(
        title="test",
        kind="current",
        segments=[
            {"role": "patient", "text": "Мой рост 1,70 м, вес 65 кг. Гемоглобин 11,2 г/дл."},
            {"role": "doctor", "text": "Целевой гемоглобин 150 г/л, запас железа 500 мг."},
            {"role": "patient", "text": "У мамы вес 90 кг."},
            {"role": "patient", "text": "Раньше вес был 80 кг."},
            {"role": "unknown", "text": "Вес 100 кг"},
        ],
    )
    values = [(m["kind"], m["value"]) for m in find_measurements([record])]
    assert values == [
        ("height_cm", "170"),
        ("weight_kg", "65"),
        ("hb_g_l", "112"),
        ("target_hb_g_l", "150"),
        ("iron_store_mg", "500"),
    ]


def test_bmi_and_ganzoni_decimal_arithmetic():
    result = calculate(
        CalculationInput(
            expected_revision=1,
            mode="iron_deficit",
            height_cm="170",
            weight_kg="65",
            hb_g_l="112",
            target_hb_g_l="150",
            iron_store_mg="500",
        )
    )
    assert result.bmi == "22.5"
    assert result.iron_deficit_mg == "1092.8"
    assert result.dose_mg is None
    assert "не разовая" in result.text


@pytest.mark.parametrize("value", [0, -1, "NaN", "Infinity", "1e-100"])
def test_invalid_measurements_rejected(client, value):
    response = post(client, start(client, False), "calculate", height_cm=value, weight_kg=65)
    assert response.status_code == 422


def test_calculation_apply_preserves_doctor_text_and_invalidates_confirmation(client):
    workspace = post(client, start(client), "analyze").json()
    old_recommendations = workspace["fields"]["recommendations"]
    workspace = post(client, workspace, "confirm").json()
    workspace = post(client, workspace, "calculate", height_cm=170, weight_kg=65).json()
    assert post(client, workspace, "calculation/apply").status_code == 409
    workspace = post(
        client, workspace, "calculate", height_cm=170, weight_kg=65, reviewed=True
    ).json()
    workspace = post(client, workspace, "calculation/apply").json()
    assert old_recommendations in workspace["fields"]["recommendations"]
    assert "22.5" in workspace["fields"]["recommendations"]
    assert workspace["confirmed_revision"] is None
    assert post(client, workspace, "calculation/apply").json()["revision"] == workspace["revision"]


def test_weight_rule_maximum_is_not_silently_capped(client):
    workspace = post(
        client,
        start(client, False),
        "calculate",
        mode="weight_rule",
        height_cm=170,
        weight_kg=65,
        medication="Учебный препарат",
        rate_mg_kg=2,
        maximum_mg=100,
        rule_source="Вымышленное правило для теста",
        reviewed=True,
    ).json()
    assert workspace["calculation"]["dose_mg"] == "130"
    assert workspace["calculation"]["exceeds_maximum"]
    assert post(client, workspace, "calculation/apply").status_code == 409
