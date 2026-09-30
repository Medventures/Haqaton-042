"""Exercise the real HTTP round trip with the approved demo recording, never print it."""

import os
from time import perf_counter

import httpx


def main():
    base = os.getenv("DEMO_BACKEND_URL", "http://127.0.0.1:8000")
    with httpx.Client(base_url=base, timeout=20) as client:

        def request(method, path, **kwargs):
            response = client.request(method, "/api" + path, **kwargs)
            response.raise_for_status()
            return response.json() if response.content else None

        connection = request("POST", "/integrations/mis/check")
        assert connection["status"] == "connected"
        library = request("GET", "/workspaces/saved-transcripts")
        if not library:
            raise SystemExit(
                "Import the approved test recording first: python -m app.import_demo /seed"
            )
        started = perf_counter()
        workspace = request("POST", "/workspaces")
        path = "/workspaces/" + workspace["id"]
        try:
            workspace = request(
                "POST",
                path + "/saved-transcripts/" + library[0]["id"],
                json={
                    "expected_revision": workspace["revision"],
                    "title": library[0]["title"],
                    "kind": "current",
                },
            )
            workspace = request(
                "POST", path + "/draft", json={"expected_revision": workspace["revision"]}
            )
            assert workspace["fields"]["complaints"], (
                "Prepared demo needs reviewed patient role suggestions"
            )
            workspace = request(
                "POST", path + "/confirm", json={"expected_revision": workspace["revision"]}
            )
            body = {
                "expected_revision": workspace["revision"],
                "patient_id": "demo-patient-001",
                "synthetic_data_confirmed": True,
            }
            receipt = request("POST", path + "/mis-export", json=body)
            repeated = request("POST", path + "/mis-export", json=body)
            assert repeated["document_id"] == receipt["document_id"]
            stored = request("GET", "/integrations/mis/documents/" + receipt["document_id"])
            assert stored["document"]["fields"] == workspace["fields"]
            assert stored["document"]["patient_id"] == "demo-patient-001"
            assert "audio" not in stored["document"] and "records" not in stored["document"]
            print(
                "PASS: existing recording -> draft -> API-key protected MIS -> database readback "
                f"in {perf_counter() - started:.2f}s"
            )
            print("PASS: repeated send returned the same document ID")
            print("Receipt:", receipt["document_id"])
        finally:
            request("DELETE", path)
        settings = request("GET", "/integrations/mis/settings")
        invalid = httpx.get(
            settings["destination"].rstrip("/") + "/patients",
            headers={"X-API-Key": "deliberately-invalid-test-key"},
            timeout=10,
        )
        assert invalid.status_code == 401
        print("PASS: incorrect API key rejected with HTTP 401")


if __name__ == "__main__":
    main()
