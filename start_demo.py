"""Local demo launcher. Run using the Python environment containing requirements."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--component', choices=['speech', 'backend', 'frontend'])
args = parser.parse_args()
key_file = ROOT / '.local-api-key'
if not key_file.exists():
    key_file.write_text(secrets.token_urlsafe(32), encoding='utf-8')
key = key_file.read_text(encoding='utf-8').strip()
runtime = ROOT / '.runtime'
runtime.mkdir(exist_ok=True)
if args.component == 'speech':
    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env')
    sys.path.insert(0, str(ROOT / 'transcription'))
    cached = ROOT.parent.parent / 'work/model-cache/direct-large-v3'
    os.environ['TRANSCRIPTION_API_KEY'] = key
    os.environ.setdefault('WHISPER_MODEL', str(cached) if cached.exists() else 'large-v3')
    os.environ.setdefault('MODEL_DIR', str(runtime / 'models'))
    os.environ['DATA_DIR'] = str(runtime / 'speech-data')
    old_cache = ROOT.parent.parent / 'work/model-cache'
    os.environ.setdefault('TORCH_HOME', str(old_cache / 'torch' if old_cache.exists() else runtime / 'torch'))
    os.environ.setdefault('HF_HOME', str(runtime / 'huggingface'))
    os.environ.setdefault('DEVICE', 'cpu')
    os.environ.setdefault('COMPUTE_TYPE', 'int8')
    os.environ.setdefault('BATCH_SIZE', '1')
    import uvicorn
    uvicorn.run('app.main:application', factory=True, host='127.0.0.1', port=8000, access_log=False)
elif args.component == 'backend':
    sys.path.insert(0, str(ROOT / 'backend'))
    os.environ.update(MEDHUB_DEMO_ENABLED='true', MEDHUB_WHISPERX_PROTOCOL='jobs',
                      MEDHUB_WHISPERX_BASE_URL='http://127.0.0.1:8000',
                      MEDHUB_WHISPERX_API_TOKEN=key, MEDHUB_DATA_DIR=str(runtime / 'backend-data'),
                      MEDHUB_SPEECH_CACHE_ENABLED='true')
    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env')
    import uvicorn
    uvicorn.run('app.main:app', host='127.0.0.1', port=8001, access_log=False)
elif args.component == 'frontend':
    node = shutil.which('node')
    if not node:
        raise SystemExit('Install Node.js 24 first')
    raise SystemExit(subprocess.call([node, 'node_modules/vite/bin/vite.js', 'preview',
                                     '--configLoader', 'native', '--host', '127.0.0.1',
                                     '--port', '5173'], cwd=ROOT / 'frontend'))
else:
    processes = []
    try:
        for component in ['speech', 'backend', 'frontend']:
            command = [sys.executable, str(Path(__file__).resolve()), '--component', component]
            cwd = ROOT
            if component == 'frontend':
                node = shutil.which('node')
                if not node:
                    raise RuntimeError('Install Node.js 24 first')
                command = [node, 'node_modules/vite/bin/vite.js', 'preview', '--configLoader',
                           'native', '--host', '127.0.0.1', '--port', '5173']
                cwd = ROOT / 'frontend'
            processes.append(subprocess.Popen(command, cwd=cwd,
                                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0))
        print('Demo: http://127.0.0.1:5173 — Ctrl+C to stop', flush=True)
        while all(p.poll() is None for p in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            process.wait()
