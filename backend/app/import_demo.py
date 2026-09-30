"""Run inside backend: python -m app.import_demo /seed."""
import json
import sys
from pathlib import Path

from app.config import Settings
from app.services.speech_cache import SpeechCache
from app.workspace_models import SpeechResult


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '/seed')
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    audio = (root / manifest['audio']).read_bytes()
    result = SpeechResult.model_validate_json((root / manifest['transcript']).read_text(encoding='utf-8'))
    settings = Settings()
    if not settings.database_url:
        raise SystemExit('MEDHUB_DATABASE_URL is required: import must target PostgreSQL')
    # Explicitly approved test recording only; never enables caching of arbitrary uploads.
    cache = SpeechCache(settings.model_copy(update={"speech_cache_enabled": True}))
    identifier = cache.key(audio, manifest['language'])
    cache.put(identifier, manifest['title'], manifest['language'], result, audio)
    assert cache.get_audio(identifier) == audio
    assert len(cache.get(identifier).segments) == len(result.segments)
    print(f'PostgreSQL import verified: {len(audio)} audio bytes, {len(result.segments)} transcript segments.')


if __name__ == '__main__':
    main()
