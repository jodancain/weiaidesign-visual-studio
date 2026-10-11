FROM python:3.11-slim
WORKDIR /worker
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py prepare_models.py download_models.py model-sources.json ./
ENV PYTHONDONTWRITEBYTECODE=1 PORT=8080 IMAGE2_OCR_MODEL_DIR=/models/ocr HOME=/tmp PADDLE_PDX_CACHE_HOME=/tmp/paddlex
USER 65534:65534
EXPOSE 8080
CMD ["python", "worker.py"]
