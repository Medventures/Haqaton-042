"""One inference at a time, local binding by default, temporary audio only."""

import asyncio
import importlib.util
import os
import secrets
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="MedHub WhisperX worker")
gate = asyncio.Lock()
model = None
diarizer = None
MAX_BYTES = 30 * 1024 * 1024
MAX_SECONDS = 1800


def authenticate(request: Request):
    token = os.getenv("WHISPERX_API_TOKEN", "")
    if token and not secrets.compare_digest(
        request.headers.get("authorization", ""), f"Bearer {token}"
    ):
        raise HTTPException(401, "Invalid worker token")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisperx_installed": importlib.util.find_spec("whisperx") is not None,
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "model_loaded": model is not None,
        "diarization_configured": bool(os.getenv("HF_TOKEN")),
        "busy": gate.locked(),
    }


def recognize(path: Path, language: str) -> dict:
    global model, diarizer
    import numpy as np
    import whisperx

    # Bound decoded duration as well as uploaded bytes (small compressed files can be long).
    decoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-t",
            str(MAX_SECONDS + 1),
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=90,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    audio = np.frombuffer(decoded.stdout, np.float32).copy()
    if len(audio) == 0 or len(audio) > MAX_SECONDS * 16000:
        raise ValueError("Audio must contain between 0 and 1800 seconds")
    device = os.getenv("WHISPERX_DEVICE", "cpu")
    if model is None:
        model = whisperx.load_model(
            os.getenv("WHISPERX_MODEL", "small"),
            device,
            compute_type=os.getenv("WHISPERX_COMPUTE_TYPE", "int8"),
            vad_method="silero",
        )
    result = model.transcribe(
        audio,
        batch_size=int(os.getenv("WHISPERX_BATCH_SIZE", "4")),
        language=None if language == "auto" else language,
    )
    if os.getenv("HF_TOKEN"):
        from whisperx.diarize import DiarizationPipeline

        if diarizer is None:
            diarizer = DiarizationPipeline(token=os.environ["HF_TOKEN"], device=device)
        result = whisperx.assign_word_speakers(diarizer(audio), result)
    segments = [
        {
            "start": float(s["start"]),
            "end": float(s["end"]),
            "text": s["text"].strip(),
            "speaker_id": s.get("speaker"),
            "role": "unknown",
        }
        for s in result["segments"]
        if s["text"].strip()
    ]
    if not segments:
        raise ValueError("No speech detected")
    # Segment timestamps only. No word alignment or inferred doctor/patient roles.
    return {"language": result.get("language", "unknown"), "segments": segments}


@app.post("/transcribe")
async def transcribe(request: Request, language: Literal["ru", "kk", "auto"] = "ru"):
    authenticate(request)
    if gate.locked():
        raise HTTPException(429, "Worker busy")
    async with gate:
        with TemporaryDirectory(prefix="medhub-audio-") as directory:
            path = Path(directory) / "input.audio"
            count = 0
            with path.open("wb") as target:
                async for chunk in request.stream():
                    count += len(chunk)
                    if count > MAX_BYTES:
                        raise HTTPException(413, "Audio exceeds 30 MiB")
                    target.write(chunk)
            if not count:
                raise HTTPException(422, "Empty audio")
            try:
                return await run_in_threadpool(recognize, path, language)
            except Exception:
                raise HTTPException(
                    503,
                    "Transcription failed; check audio, ffmpeg, models and device configuration",
                ) from None
