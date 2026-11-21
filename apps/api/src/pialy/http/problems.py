"""RFC 9457 problem details (`application/problem+json`) with the request id."""

from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from pialy.observability.logging import request_id

PROBLEM_MEDIA_TYPE = "application/problem+json"


class ProblemError(Exception):
    """Raise anywhere under a request; rendered as a problem with this status."""

    def __init__(self, status: int, type_urn: str, title: str, detail: str | None = None) -> None:
        super().__init__(title)
        self.status = status
        self.type_urn = type_urn
        self.title = title
        self.detail = detail


def _phrase(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Error"


def problem_response(
    status: int,
    *,
    type_urn: str = "about:blank",
    title: str | None = None,
    detail: str | None = None,
    extra: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body: dict[str, object] = {
        "type": type_urn,
        "title": title or _phrase(status),
        "status": status,
    }
    if detail is not None:
        body["detail"] = detail
    body.update(extra or {})
    body["requestId"] = request_id.get()
    return JSONResponse(body, status_code=status, media_type=PROBLEM_MEDIA_TYPE, headers=headers)


def _problem_error(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ProblemError)  # noqa: S101 - registered for this type only
    return problem_response(exc.status, type_urn=exc.type_urn, title=exc.title, detail=exc.detail)


def _http_error(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 - registered for this type only
    # Starlette's own details ("Not Found", "Method Not Allowed") repeat the title.
    detail = None if exc.detail == _phrase(exc.status_code) else exc.detail
    return problem_response(exc.status_code, detail=detail, headers=dict(exc.headers or {}))


def _validation_error(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)  # noqa: S101 - registered for this type only
    # Only where and what kind: the message and the input could echo a phone or a token.
    errors = [{"loc": list(error["loc"]), "type": error["type"]} for error in exc.errors()]
    return problem_response(422, detail="The request is not valid.", extra={"errors": errors})


def install_problem_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ProblemError, _problem_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
