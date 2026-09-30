import asyncio
import hmac
import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel

from .config import Settings
from .engine import AudioError, WhisperEngine
from .store import Store

logger = logging.getLogger('transcription')


class Segment(BaseModel):
    start: float
    end: float
    text: str
    speaker_id: str | None = None


class JobResponse(BaseModel):
    id: UUID
    status: Literal['queued', 'processing', 'completed', 'failed']
    created_at: str
    language: str
    text: str | None = None
    segments: list[Segment] | None = None
    duration_seconds: float | None = None
    timestamp_precision: str | None = None
    warnings: list[str] | None = None
    error: str | None = None


def create_app(settings: Settings | None = None, engine=None):
    settings = settings or Settings()
    settings.validate()
    store = Store(settings.data_dir)
    engine = engine or WhisperEngine(settings)
    stop = threading.Event()
    upload_lock = asyncio.Lock()

    def worker():
        last_cleanup = 0
        while not stop.is_set():
            if time.time() - last_cleanup > 30:
                store.expire(settings.retention_seconds)
                last_cleanup = time.time()
            job = store.claim()
            if not job:
                stop.wait(0.25)
                continue
            path = settings.data_dir / f"{job['id']}.upload"
            try:
                result = engine.transcribe(path, job['language'], job['vocabulary'])
                store.finish(job['id'], result=result)
            except AudioError as exc:
                store.finish(job['id'], error=str(exc))
            except Exception:
                # Never log audio, vocabulary, transcript, filenames or raw exceptions.
                logger.error('Transcription failed; inspect runtime dependencies and model availability')
                store.finish(job['id'], error='transcription_failed')
            finally:
                path.unlink(missing_ok=True)

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        # Clean uploads left by interrupted HTTP requests (keep queued job inputs).
        for path in settings.data_dir.glob('*.upload'):
            if store.get(path.stem) is None:
                path.unlink(missing_ok=True)
        for path in settings.data_dir.glob('*.normalized.wav'):
            path.unlink(missing_ok=True)
        thread = threading.Thread(target=worker, daemon=True, name='transcription-worker')
        thread.start()
        app.state.worker = thread
        yield
        stop.set()
        await asyncio.to_thread(thread.join, 5)

    app = FastAPI(title='Medical transcription API', version='1.0.0', lifespan=lifespan)
    app.state.store = store
    app.state.engine = engine

    @app.exception_handler(RequestValidationError)
    async def explain_validation(request, exc):
        errors = [{'loc': list(error['loc']), 'msg': error['msg'], 'type': error['type']}
                  for error in exc.errors()]
        fields = {str(error['loc'][-1]) for error in errors if error['loc']}
        if 'file' in fields:
            message = 'Выберите аудиофайл в поле file и отправьте multipart/form-data.'
        elif 'language' in fields:
            message = 'В поле language укажите ru, kk или auto.'
        elif 'identifier' in fields:
            message = 'Вставьте полный UUID из ответа POST со статусом 202.'
        elif 'vocabulary' in fields:
            message = 'Подсказка vocabulary должна содержать не более 1000 символов.'
        else:
            message = 'Проверьте поля, перечисленные в detail.'
        body = {'detail': errors, 'message': message}
        if request.method == 'POST' and request.url.path == '/transcriptions':
            body['job_created'] = False
            body['next_step'] = 'Исправьте запрос и повторите POST. При 422 id задания не создаётся.'
        return JSONResponse(body, status_code=422, headers={'Cache-Control': 'no-store'})

    @app.middleware('http')
    async def upload_guard(request, call_next):
        if request.method == 'POST' and request.url.path == '/transcriptions':
            key = request.headers.get('x-api-key', '')
            if not hmac.compare_digest(key.encode(), settings.api_key.encode()):
                return JSONResponse({'detail': 'Invalid API key'}, status_code=401)
            try:
                length = int(request.headers['content-length'])
            except KeyError:
                return JSONResponse({'detail': 'Content-Length required'}, status_code=411)
            except ValueError:
                return JSONResponse({'detail': 'Invalid Content-Length'}, status_code=400)
            if length < 0 or length > settings.max_bytes + 1024 * 1024:
                return JSONResponse({'detail': 'Request too large'}, status_code=413)
        response = await call_next(request)
        if request.url.path.startswith('/transcriptions'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    key_header = APIKeyHeader(name='X-API-Key', auto_error=False)

    def authorize(x_api_key: Annotated[str | None, Depends(key_header)] = None):
        if not x_api_key or not hmac.compare_digest(x_api_key.encode(), settings.api_key.encode()):
            raise HTTPException(401, 'Invalid API key')

    auth = [Depends(authorize)]

    def response(job):
        result = json.loads(job['result']) if job['result'] else {}
        return {'id': job['id'], 'status': job['status'],
                'created_at': datetime.fromtimestamp(job['created'], timezone.utc).isoformat(),
                'language': job['language'], 'error': job['error'], **result}

    def find(identifier):
        job = store.get(str(identifier))
        if not job:
            raise HTTPException(404, 'Job not found or expired')
        return job

    @app.get('/health')
    def health():
        alive = hasattr(app.state, 'worker') and app.state.worker.is_alive()
        if not alive:
            raise HTTPException(503, 'Worker unavailable')
        return {'status': 'ok', 'model_loaded': engine.loaded}

    @app.post('/transcriptions', status_code=202, response_model=JobResponse, dependencies=auth)
    async def submit(file: Annotated[UploadFile, File()],
                     language: Annotated[Literal['ru', 'kk', 'auto'], Form()] = 'ru',
                     vocabulary: Annotated[str, Form(max_length=1000)] = ''):
        identifier = str(uuid4())
        path = settings.data_dir / f'{identifier}.upload'
        try:
            async with upload_lock:
                if store.pending() >= settings.max_jobs:
                    raise HTTPException(429, 'Queue full', headers={'Retry-After': '10'})
                size = 0
                with path.open('wb') as target:
                    while chunk := await file.read(1024 * 1024):
                        size += len(chunk)
                        if size > settings.max_bytes:
                            raise HTTPException(413, 'Audio upload too large')
                        target.write(chunk)
                if size == 0:
                    raise HTTPException(400, 'Empty file')
                store.create(identifier, language, vocabulary)
                return response(find(UUID(identifier)))
        except BaseException:
            if store.get(identifier) is None:
                path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.get('/transcriptions/{identifier}', response_model=JobResponse, dependencies=auth)
    def get_job(identifier: UUID):
        return response(find(identifier))

    @app.get('/transcriptions/{identifier}/text', response_class=PlainTextResponse, dependencies=auth)
    def get_text(identifier: UUID):
        job = find(identifier)
        if job['status'] != 'completed':
            raise HTTPException(409, 'Transcription is not completed')
        return json.loads(job['result'])['text']

    @app.delete('/transcriptions/{identifier}', status_code=204, dependencies=auth)
    def delete_job(identifier: UUID):
        outcome = store.delete(str(identifier))
        if outcome == 'busy':
            raise HTTPException(409, 'Processing job cannot be deleted yet')
        if outcome == 'missing':
            raise HTTPException(404, 'Job not found or expired')

    return app


def application():
    return create_app()
