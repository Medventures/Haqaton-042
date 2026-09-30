import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv('DATA_DIR', './data')))
    model_dir: str = field(default_factory=lambda: os.getenv('MODEL_DIR', './models'))
    api_key: str = field(default_factory=lambda: os.getenv('TRANSCRIPTION_API_KEY', ''))
    model: str = field(default_factory=lambda: os.getenv('WHISPER_MODEL', 'large-v3'))
    hf_token: str = field(default_factory=lambda: os.getenv('HF_TOKEN', ''), repr=False)
    device: str = field(default_factory=lambda: os.getenv('DEVICE', 'cpu'))
    compute_type: str = field(default_factory=lambda: os.getenv('COMPUTE_TYPE', 'int8'))
    batch_size: int = field(default_factory=lambda: int(os.getenv('BATCH_SIZE', '1')))
    max_bytes: int = field(default_factory=lambda: int(os.getenv('MAX_UPLOAD_MB', '100')) * 1024 * 1024)
    max_seconds: int = field(default_factory=lambda: int(os.getenv('MAX_AUDIO_SECONDS', '1800')))
    max_jobs: int = field(default_factory=lambda: int(os.getenv('MAX_PENDING_JOBS', '10')))
    retention_seconds: int = field(default_factory=lambda: int(os.getenv('RESULT_RETENTION_SECONDS', '86400')))

    def validate(self):
        if len(self.api_key) < 24:
            raise ValueError('Set TRANSCRIPTION_API_KEY to a random secret of at least 24 characters')
        if self.device not in ('cpu', 'cuda') or min(self.batch_size, self.max_bytes, self.max_seconds, self.max_jobs, self.retention_seconds) < 1:
            raise ValueError('Invalid runtime settings')
