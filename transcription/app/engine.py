import os
import shutil
import subprocess
import wave
from dataclasses import replace
from pathlib import Path

from .config import Settings

# No optional usage telemetry from model libraries in this clinical service.
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('DO_NOT_TRACK', '1')
os.environ.setdefault('PYANNOTE_METRICS_ENABLED', '0')


class AudioError(Exception):
    pass


class WhisperEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model = None
        self.diarizer = None

    @property
    def loaded(self):
        return self.model is not None

    def load(self):
        if self.model is None:
            import whisperx
            self.model = whisperx.load_model(
                self.settings.model, self.settings.device,
                compute_type=self.settings.compute_type,
                download_root=self.settings.model_dir,
                vad_method='silero',
                asr_options={'beam_size': 5, 'condition_on_previous_text': False},
            )

    def transcribe(self, path: Path, language: str, vocabulary: str):
        import numpy as np
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        normalized = path.parent / (path.name + '.normalized.wav')
        try:
            # Do not allow network protocols in uploaded media or unbounded decoding.
            result = subprocess.run([
                ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-format_whitelist', 'wav,mp3,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,flac,aac',
                '-protocol_whitelist', 'file,pipe', '-i', str(path),
                '-t', str(self.settings.max_seconds + 1), '-vn',
                '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', str(normalized),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            if result.returncode:
                raise AudioError('invalid_audio')
            with wave.open(str(normalized), 'rb') as wav:
                duration = wav.getnframes() / wav.getframerate()
                if duration > self.settings.max_seconds:
                    raise AudioError('audio_too_long')
                if duration == 0:
                    raise AudioError('empty_audio')
                audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            self.load()
            warnings = ['mixed_language_not_validated'] if language == 'auto' else []
            if vocabulary:
                tokens = self.model.model.hf_tokenizer.encode(vocabulary).ids
                if len(tokens) > 200:
                    vocabulary = self.model.model.hf_tokenizer.decode(tokens[:200])
                    warnings.append('vocabulary_truncated')
            # All calls run in one worker: WhisperX tokenizers/options are mutable.
            # Vocabulary is a decoding hint, never automatic text replacement.
            self.model.options = replace(self.model.options, initial_prompt=vocabulary or None)
            if self.settings.hf_token:
                import torch
                from pyannote.audio import Pipeline
                if self.diarizer is None:
                    self.diarizer = Pipeline.from_pretrained(
                        'pyannote/speaker-diarization-community-1', token=self.settings.hf_token,
                    ).to(torch.device(self.settings.device))
                diarized = self.diarizer({'waveform': torch.from_numpy(audio).unsqueeze(0),
                                          'sample_rate': 16000})
                turns = []
                for turn, _, speaker in diarized.exclusive_speaker_diarization.itertracks(yield_label=True):
                    if turns and turns[-1][2] == speaker and turn.start - turns[-1][1] < 0.8:
                        turns[-1][1] = turn.end
                    else:
                        turns.append([turn.start, turn.end, speaker])
                detected = self.model.detect_language(audio) if language == 'auto' else language
                if detected not in ('ru', 'kk'):
                    raise AudioError('unsupported_detected_language')
                segments = []
                for start, end, speaker in turns:
                    if end - start < 0.1:
                        continue
                    clip_start = max(0, start - 0.08)
                    clip_end = min(duration, end + 0.08)
                    clip = audio[int(clip_start * 16000):int(clip_end * 16000)]
                    piece = self.model.transcribe(clip, batch_size=self.settings.batch_size,
                                                  language=detected, task='transcribe')
                    for item in piece['segments']:
                        segments.append({'start': float(item['start']) + clip_start,
                                         'end': min(duration, float(item['end']) + clip_start),
                                         'text': item['text'], 'speaker_id': speaker})
                result = {'language': detected, 'segments': segments}
                warnings.append('speaker_roles_require_review')
            else:
                result = self.model.transcribe(audio, batch_size=self.settings.batch_size,
                                               language=None if language == 'auto' else language,
                                               task='transcribe')
            detected = result.get('language', language)
            if detected not in ('ru', 'kk'):
                raise AudioError('unsupported_detected_language')
            segments = [{'start': round(float(s['start']), 3),
                         'end': round(float(s['end']), 3), 'text': s['text'].strip(),
                         'speaker_id': s.get('speaker_id')}
                        for s in result['segments']]
            if not segments:
                warnings.append('no_speech_detected')
            return {'language': detected, 'text': ' '.join(s['text'] for s in segments),
                    'segments': segments, 'duration_seconds': round(duration, 3),
                    'timestamp_precision': 'speaker_turn_vad' if self.settings.hf_token else 'vad_segment',
                    'warnings': warnings}
        except subprocess.TimeoutExpired:
            raise AudioError('audio_decode_timeout') from None
        finally:
            normalized.unlink(missing_ok=True)
