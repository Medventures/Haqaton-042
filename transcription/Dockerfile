FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/models/huggingface TORCH_HOME=/models/torch MODEL_DIR=/models/whisper DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /service
COPY requirements.txt .
RUN pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt
RUN useradd --uid 10001 --create-home service && mkdir /data /models && chown -R service:service /data /models
COPY --chown=service:service app ./app
USER service
EXPOSE 8000
CMD ["uvicorn", "app.main:application", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
