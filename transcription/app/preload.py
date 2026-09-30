"""Download/load the configured model before accepting the first consultation."""
from .config import Settings
from .engine import WhisperEngine

if __name__ == '__main__':
    settings = Settings()
    engine = WhisperEngine(settings)
    engine.load()
    print('Model loaded successfully')
