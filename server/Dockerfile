# QueryService – Huey OLAP backend
# Build from repo root: docker build -f server/Dockerfile .

FROM python:3.12-slim

WORKDIR /app

# Copy only server package and deps for smaller layer
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Persistent storage for export jobs and output files.
# Mount a volume at /data/exports in production to survive container restarts.
VOLUME ["/data/exports"]

EXPOSE 8000

# HEALTHCHECK uses Python's stdlib urllib to avoid requiring curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/ready')" || exit 1

# UVICORN_WORKERS defaults to 1. Override at runtime:
#   docker run -e UVICORN_WORKERS=4 ...
# Note: each worker opens its own DuckDB connection; tune accordingly.
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-1}"]
