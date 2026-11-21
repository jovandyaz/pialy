from fastapi import FastAPI

from pialy.clock import Clock, system_clock
from pialy.config import Settings, load_settings


def create_app(settings: Settings, clock: Clock) -> FastAPI:
    app = FastAPI(title="pialy", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.clock = clock
    return app


def app_factory() -> FastAPI:
    """Entry point for uvicorn: `uvicorn pialy.main:app_factory --factory`."""
    return create_app(load_settings(), system_clock)
