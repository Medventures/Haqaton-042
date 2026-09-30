"""Explicit manual API smoke test using synthetic text, never real patient data."""

import json
import sys
from pathlib import Path

import httpx
from dotenv import dotenv_values

root = Path(__file__).resolve().parents[1]
env = dotenv_values(root / ".env")
key = env.get("OPENAI_API_KEY")
if not key:
    print("OPENAI_API_KEY is missing in local .env")
    sys.exit(1)
schema = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "complaints": {"type": "string"},
        "height_cm": {"type": "number"},
        "weight_kg": {"type": "number"},
        "diagnosis": {"type": ["string", "null"]},
        "recommendations": {"type": "string"},
    },
    "required": [
        "complaints",
        "height_cm",
        "weight_kg",
        "diagnosis",
        "recommendations",
    ],
}
try:
    response = httpx.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {key}"},
        timeout=60,
        json={
            "model": env.get("OPENAI_MODEL") or "gpt-4.1-mini",
            "store": False,
            "instructions": "Extract only explicit facts. No diagnosis unless explicitly stated by the doctor. No new recommendations. Output Russian text.",
            "input": "Synthetic demo. Patient: Слабость. Мой рост 170 см, вес 65 кг. Хочу обсудить анемию. Doctor: Рекомендую принести прошлые анализы.",
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "consultation_smoke",
                    "strict": True,
                    "schema": schema,
                }
            },
            "max_output_tokens": 600,
        },
    )
    print(f"HTTP {response.status_code}")
    data = response.json()
    if response.status_code != 200:
        error = data.get("error", {})
        # Provider error messages can include key fragments. Never print them.
        print(
            json.dumps(
                {"type": error.get("type"), "code": error.get("code")},
                ensure_ascii=True,
            )
        )
        sys.exit(1)
    texts = [
        c["text"]
        for item in data.get("output", [])
        for c in item.get("content", [])
        if c.get("type") == "output_text"
    ]
    output = json.loads("".join(texts))
    print(
        json.dumps(
            {
                "model": data.get("model"),
                "status": data.get("status"),
                "result": output,
                "usage": data.get("usage"),
            },
            ensure_ascii=True,
        )
    )
    assert output["height_cm"] == 170 and output["weight_kg"] == 65
    assert output["diagnosis"] is None
    print("Synthetic extraction checks passed")
except httpx.RequestError as exc:
    print(f"Network request failed: {type(exc).__name__}")
    sys.exit(2)
