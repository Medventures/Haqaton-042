from io import BytesIO
from zipfile import ZipFile
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.speech_cache import SpeechCache
from app.services.calculations import automatic_calculation
from app.workspace_models import Record, SpeechResult


def test_cache_survives_new_instance_and_keeps_audio(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, speech_cache_enabled=True)
    cache = SpeechCache(settings)
    result = SpeechResult(language='ru', segments=[{'text':'Проверка', 'speaker_id':'SPEAKER_00'}])
    identifier = cache.key(b'audio', 'ru')
    cache.put(identifier, 'Запись', 'ru', result, b'audio')
    reopened = SpeechCache(settings)
    assert reopened.get(identifier).segments[0].speaker_id == 'SPEAKER_00'
    assert reopened.get_audio(identifier) == b'audio'
    assert reopened.key(b'different', 'ru') != identifier
    assert reopened.key(b'audio', 'kk') != identifier
    reopened.delete(identifier)
    assert reopened.get(identifier) is None


def test_document_matches_latest_fields_and_invalidates_confirmation(tmp_path):
    with TestClient(create_app(Settings(_env_file=None, data_dir=tmp_path, demo_enabled=True))) as c:
        w = c.post('/api/workspaces').json()
        base = '/api/workspaces/' + w['id']
        w = c.patch(base+'/form', json={'expected_revision':w['revision'],'fields':{'complaints':'Текст <1> & проверка'}}).json()
        r = c.post(base+'/document', json={'expected_revision':w['revision']})
        assert r.status_code == 200
        with ZipFile(BytesIO(r.content)) as package:
            document = ElementTree.fromstring(package.read('word/document.xml'))
            text = ''.join(document.itertext())
            assert 'Текст <1> & проверка' in text and 'Черновик' in text
        c.post(base+'/confirm', json={'expected_revision':w['revision']}).raise_for_status()
        w = c.patch(base+'/form', json={'expected_revision':w['revision'],'fields':{'complaints':'Исправленная версия'}}).json()
        assert w['confirmed_revision'] is None
        assert c.post(base+'/document', json={'expected_revision':w['revision']-1}).status_code == 409


def test_automatic_history_selection_and_conflicts():
    history = Record(kind='history', title='Прошлый приём', visit_date='2026-09-01', segments=[
        {'role':'patient', 'text':'Рост 170 см, вес 65 кг.'}])
    current = Record(kind='current', title='Сегодня', segments=[{'role':'patient','text':'Вес 66 кг.'}])
    result = automatic_calculation([history,current], 1)
    assert result['result']['bmi'] == '22.8'
    assert result['uses_history'] and result['result']['weight_kg'] == '66'
    current.segments.append(current.segments[0].model_copy(update={'text':'Вес 70 кг.'}))
    conflict = automatic_calculation([history,current], 1)
    assert conflict['result'] is None and conflict['conflicts'][0]['field'] == 'weight_kg'


def test_draft_refresh_preserves_manual_corrections(tmp_path):
    with TestClient(create_app(Settings(_env_file=None, data_dir=tmp_path, demo_enabled=True))) as c:
        w = c.post('/api/workspaces').json(); base='/api/workspaces/'+w['id']
        w = c.post(base+'/records',json={'expected_revision':w['revision'],'title':'Тест','kind':'current',
                  'segments':[{'text':'Жалобы: слабость.','role':'patient'}]}).json()
        w = c.post(base+'/draft',json={'expected_revision':w['revision']}).json()
        assert w['fields']['complaints'] == 'Жалобы: слабость.'
        w = c.patch(base+'/form',json={'expected_revision':w['revision'],'fields':{'complaints':'Правка врача'}}).json()
        w = c.post(base+'/draft',json={'expected_revision':w['revision']}).json()
        assert w['fields']['complaints'] == 'Правка врача'


def test_saved_transcript_import_and_audio(tmp_path):
    settings=Settings(_env_file=None,data_dir=tmp_path,demo_enabled=True,speech_cache_enabled=True)
    cache=SpeechCache(settings)
    cache.put('demo','Моя запись','ru',SpeechResult(language='ru',segments=[{'text':'Тест'}]),b'RIFFtest')
    with TestClient(create_app(settings)) as c:
        w=c.post('/api/workspaces').json()
        loaded=c.post('/api/workspaces/'+w['id']+'/saved-transcripts/demo',json={'expected_revision':1}).json()
        assert loaded['records'][0]['segments'][0]['text']=='Тест'
        assert c.get('/api/workspaces/saved-transcripts/demo/audio').content==b'RIFFtest'
        assert c.get('/api/workspaces/capabilities').json()['openai_status']=='missing_key'
