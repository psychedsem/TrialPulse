FROM python:3.14.2-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TRIALPULSE_PANDAS_ENABLED=0
WORKDIR /app
COPY data_agent/requirements-runtime.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && useradd --create-home app
COPY data_agent/ ./data_agent/
COPY data/trialpulse_operations.csv ./data/trialpulse_operations.csv
WORKDIR /app/data_agent
USER app
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
