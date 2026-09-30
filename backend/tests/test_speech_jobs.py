import asyncio

import httpx
import pytest

from app.config import Settings
from app.integrations.speech_client import recognize


@pytest.mark.parametrize('failed', [False, True])
def test_jobs_contract_and_cleanup(monkeypatch, failed):
    requests = []
    def handler(request):
        requests.append(request)
        assert request.headers['X-API-Key'] == 'test-secret'
        if request.method == 'POST':
            assert b'name="file"' in request.content
            return httpx.Response(202, json={'id': 'job-1'})
        if request.method == 'DELETE':
            return httpx.Response(204)
        return httpx.Response(200, json={
            'status': 'failed' if failed else 'completed', 'language': 'kk',
            'segments': [{'start': 0, 'end': 2, 'text': 'Сәлеметсіз бе?'}],
            'extra_field_from_service': True,
        })
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(handler)))
    settings = Settings(_env_file=None, whisperx_base_url='http://speech',
                        whisperx_protocol='jobs', whisperx_api_token='test-secret')
    if failed:
        with pytest.raises(ValueError):
            asyncio.run(recognize(settings, b'audio', 'kk'))
    else:
        result = asyncio.run(recognize(settings, b'audio', 'kk'))
        assert result.language == 'kk'
        assert result.segments[0].role == 'unknown'
        assert result.segments[0].text == 'Сәлеметсіз бе?'
    assert [r.method for r in requests] == ['POST', 'GET', 'DELETE']
