import asyncio
import time

import httpx

from app.config import Settings
from app.workspace_models import SpeechResult


async def recognize(settings: Settings, audio: bytes, language: str) -> SpeechResult:
    base = settings.whisperx_base_url.rstrip('/')
    async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
        if settings.whisperx_protocol == 'worker':
            headers = {'Content-Type': 'application/octet-stream'}
            if settings.whisperx_api_token:
                headers['Authorization'] = f'Bearer {settings.whisperx_api_token}'
            response = await client.post(base + '/transcribe', params={'language': language},
                                         content=audio, headers=headers, timeout=900)
            response.raise_for_status()
            return SpeechResult.model_validate(response.json())
        headers = {'X-API-Key': settings.whisperx_api_token}
        response = await client.post(base + '/transcriptions', headers=headers,
                                     files={'file': ('recording.audio', audio, 'application/octet-stream')},
                                     data={'language': language, 'vocabulary': settings.whisperx_vocabulary})
        response.raise_for_status()
        identifier = response.json()['id']
        deadline = time.monotonic() + 1800
        try:
            while time.monotonic() < deadline:
                response = await client.get(base + '/transcriptions/' + identifier, headers=headers)
                response.raise_for_status()
                job = response.json()
                if job['status'] == 'failed':
                    raise ValueError('Speech job failed')
                if job['status'] == 'completed':
                    # Keep only contract fields; do not invent speakers or roles.
                    return SpeechResult.model_validate({
                        'language': job['language'],
                        'segments': [{'start': s['start'], 'end': s['end'], 'text': s['text'],
                                      'speaker_id': s.get('speaker_id'), 'role': 'unknown'} for s in job['segments']],
                    })
                await asyncio.sleep(1)
            raise TimeoutError('Speech job timed out')
        finally:
            # Backend holds the result; avoid a second retained clinical transcript.
            # A processing job returns 409 and remains subject to service retention.
            try:
                await client.delete(base + '/transcriptions/' + identifier, headers=headers, timeout=10)
            except httpx.HTTPError:
                pass
