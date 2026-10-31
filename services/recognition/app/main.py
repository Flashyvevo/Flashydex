"""ASGI entrypoint: uvicorn app.main:app (prefer scripts/recognition/serve.sh)."""
from app.api.app import create_app

app = create_app()
