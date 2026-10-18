FROM python:3.14.2-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/home/app/.cache/huggingface
WORKDIR /app
COPY rag/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && useradd --create-home app
COPY rag/ ./rag/
COPY knowledge_base/ ./knowledge_base/
RUN mkdir -p /app/rag/chroma_db /home/app/.cache/huggingface && chown -R app:app /app/rag/chroma_db /home/app/.cache
WORKDIR /app/rag
USER app
EXPOSE 8001
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
