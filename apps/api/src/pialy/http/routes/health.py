"""Liveness (`/healthz`) and readiness (`/readyz`)."""

import logging

from fastapi import APIRouter

from pialy.http.problems import ProblemError
from pialy.observability.readiness import ReadinessCheck

logger = logging.getLogger("pialy.http")


def health_router(readiness: ReadinessCheck) -> APIRouter:
    router = APIRouter()

    @router.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/readyz")
    def readyz() -> dict[str, str]:
        try:
            ready = readiness()
        except Exception:
            logger.exception("readiness check failed")
            ready = False
        if not ready:
            raise ProblemError(
                503, "urn:pialy:problem:not-ready", "Service Unavailable", "Not ready."
            )
        return {"status": "ready"}

    return router
