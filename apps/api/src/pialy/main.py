from fastapi import FastAPI

from pialy.clock import Clock, system_clock
from pialy.config import Settings, load_settings
from pialy.http.problems import install_problem_handlers
from pialy.http.request_context import RequestContextMiddleware
from pialy.http.routes.health import health_router
from pialy.http.security_headers import SecurityHeadersMiddleware
from pialy.observability.errors import init_error_reporting
from pialy.observability.logging import configure_logging
from pialy.observability.readiness import ReadinessCheck, database_readiness


def create_app(
    settings: Settings, clock: Clock, readiness: ReadinessCheck | None = None
) -> FastAPI:
    app = FastAPI(title="pialy", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.clock = clock
    check = (
        readiness
        if readiness is not None
        else database_readiness(settings.database_url.get_secret_value())
    )
    install_problem_handlers(app)
    app.include_router(health_router(check))
    # The last one added is the outermost: security headers wrap the request context.
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(SecurityHeadersMiddleware, hsts=settings.env == "production")
    return app


def app_factory() -> FastAPI:
    """Entry point for uvicorn: `uvicorn pialy.main:app_factory --factory`."""
    settings = load_settings()
    configure_logging(settings.log_level)
    init_error_reporting(settings)
    return create_app(settings, system_clock)
