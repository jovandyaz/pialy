"""Fake pey: the CoDi calls `packages/connector-pey` makes, plus `/_control/*` endpoints for the suite.

Control bodies carry integer minor units; pey's own bodies carry decimal pesos. Webhooks are signed
the Standard Webhooks way with the secret in `--secret-file`. Endpoints are listed in the README.
"""

from __future__ import annotations

import http.client
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, TypeGuard
from urllib.parse import urlsplit

from agent_toolkit.webhooks.testing import sign

from currency import CURRENCY, pesos

type JsonObject = dict[str, object]
type ChargeKind = Literal["pn", "qr"]

SYNTHETIC_CLABE = "123456789012345678"
DEFAULT_BANK_CODE = 40012
CODI_ACCOUNT_TYPE = 40
API_KEY_ID = "01FAKEPEYAPIKEY00000000000"
BANK_ACCOUNT_ID = "01FAKEPEYBANKACCOUNT000000"
CODI_ID_DIGITS = 20
TRACKING_KEY_DIGITS = 10
QR_ID_BYTES = 5
STALL_LIMIT_SECONDS = 30.0
# Below the suite's 15 s request timeout, so a hung target answers 502 before the control call gives up.
DELIVERY_TIMEOUT_SECONDS = 10.0
MAX_BODY_BYTES = 1_000_000
MAX_CONTENT_LENGTH_DIGITS = len(str(MAX_BODY_BYTES))
WEBHOOK_SCHEMES = ("http", "https")
MAX_HTTP_STATUS = 599

URL_FORBIDDEN_CHARS = re.compile(r"[\x00-\x20\x7f]")
TRANSACTION_PATH = re.compile(r"^/transaction/([^/]+)$")
QR_TRANSACTIONS_PATH = re.compile(r"^/transaction/codi/qr/([^/]+)$")


class ControlError(Exception):
    """A request the fake cannot honor; answered with `status` and the message."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class PaymentMetadata(TypedDict):
    clabe: str
    accountType: int
    description: str
    trackingKey: str
    externalMetadata: JsonObject
    bankCode: NotRequired[int]


class PeyWebhook(TypedDict):
    """A `codi.pn.payment_received` or `codi.qr.payment_received` event as pey sends it."""

    amount: float
    apiKeyId: str
    concept: str
    datePaid: int
    metadata: PaymentMetadata
    numRef: str
    transactionId: str
    type: str
    bankAccountId: NotRequired[str]
    codiQrId: NotRequired[str]


@dataclass(frozen=True)
class Charge:
    kind: ChargeKind
    ref: str
    concept: str
    num_ref: str
    metadata: JsonObject
    expiration: int
    created_at: int


@dataclass(frozen=True)
class Payment:
    transaction_id: str
    charge: Charge
    amount_minor: int
    fee_minor: int
    date_paid: int
    tracking_key: str
    bank_code: int | None


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    path: str
    authorized: bool
    body: JsonObject | None
    status: int
    response: JsonObject


@dataclass(frozen=True)
class DeliveryOptions:
    url: str
    webhook_id: str
    signed_at: datetime
    send: bool


@dataclass
class State:
    charges: dict[str, Charge] = field(default_factory=dict)
    payments: dict[str, Payment] = field(default_factory=dict)
    requests: list[RecordedRequest] = field(default_factory=list)
    failures: list[int] = field(default_factory=list)
    stall_next: bool = False
    stalled: list[threading.Event] = field(default_factory=list)


def is_int(value: object) -> TypeGuard[int]:
    """A JSON integer: `true` and `false` parse to Python ints but are not counts or codes."""
    return isinstance(value, int) and not isinstance(value, bool)


def new_transaction_id() -> str:
    return "01" + secrets.token_hex(12).upper()


def digits(count: int) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(count))


def pey_error(status: int, message: str) -> JsonObject:
    error_type = "SERVICE_UNAVAILABLE" if status >= HTTPStatus.INTERNAL_SERVER_ERROR else "INVALID_PARAMETER"
    return {"error": {"message": message, "type": error_type, "requestId": f"req_{uuid.uuid4().hex}"}}


class FakePey:
    def __init__(self, secret_file: Path, webhook_url: str | None) -> None:
        self._secret_file = secret_file
        self._webhook_url = webhook_url
        self._lock = threading.Lock()
        self._state = State()

    def api(self, method: str, path: str, body: JsonObject | None, authorized: bool) -> tuple[int, JsonObject]:
        """Answers one pey API call and records it; a queued failure or stall applies first."""
        gate: threading.Event | None = None
        with self._lock:
            if self._state.failures:
                status = self._state.failures.pop(0)
                answer = (status, pey_error(status, "fake pey failure"))
            elif not authorized:
                answer = (HTTPStatus.UNAUTHORIZED, pey_error(HTTPStatus.UNAUTHORIZED, "missing api key"))
            else:
                answer = self._answer(method, path, body)
            self._state.requests.append(RecordedRequest(method, path, authorized, body, *answer))
            if self._state.stall_next:
                self._state.stall_next = False
                gate = threading.Event()
                self._state.stalled.append(gate)
        if gate is not None:
            gate.wait(STALL_LIMIT_SECONDS)
        return answer

    def _answer(self, method: str, path: str, body: JsonObject | None) -> tuple[int, JsonObject]:
        if method == "POST" and path in ("/codi/pn", "/codi/qr"):
            return self._create_charge("pn" if path == "/codi/pn" else "qr", body or {})
        if method == "GET" and (match := QR_TRANSACTIONS_PATH.match(path)):
            return self._qr_transactions(match.group(1))
        if method == "GET" and (match := TRANSACTION_PATH.match(path)):
            return self._transaction(match.group(1))
        return HTTPStatus.NOT_FOUND, pey_error(HTTPStatus.NOT_FOUND, "not found")

    def _create_charge(self, kind: ChargeKind, body: JsonObject) -> tuple[int, JsonObject]:
        required = ("amount", "concept", "expiration", "numRef") + (("phoneNumber",) if kind == "pn" else ())
        missing = [name for name in required if name not in body]
        if missing:
            return HTTPStatus.BAD_REQUEST, pey_error(HTTPStatus.BAD_REQUEST, f"missing {', '.join(missing)}")
        expiration, metadata = body["expiration"], body.get("metadata")
        if not is_int(expiration):
            return HTTPStatus.BAD_REQUEST, pey_error(HTTPStatus.BAD_REQUEST, "expiration must be an integer")
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            return HTTPStatus.BAD_REQUEST, pey_error(HTTPStatus.BAD_REQUEST, "metadata must be an object or null")
        ref = new_transaction_id() if kind == "pn" else secrets.token_hex(QR_ID_BYTES)
        self._state.charges[ref] = Charge(
            kind=kind,
            ref=ref,
            concept=str(body["concept"]),
            num_ref=str(body["numRef"]),
            metadata=dict(metadata),
            expiration=expiration,
            created_at=int(time.time()),
        )
        if kind == "pn":
            return HTTPStatus.CREATED, {"transactionId": ref, "codiId": digits(CODI_ID_DIGITS)}
        qr_string = json.dumps({"TYP": 20, "v": {"DEV": "00000000000000/0"}, "ic": {"IDC": ref}}, separators=(",", ":"))
        return HTTPStatus.CREATED, {"id": ref, "qrString": qr_string, "qrImage": None}

    def _transaction(self, transaction_id: str) -> tuple[int, JsonObject]:
        payment = self._state.payments.get(transaction_id)
        if payment is not None:
            return HTTPStatus.OK, transaction_body(payment)
        charge = self._state.charges.get(transaction_id)
        if charge is not None and charge.kind == "pn":
            return HTTPStatus.OK, {
                "id": charge.ref,
                "status": "PENDING",
                "currency": CURRENCY,
                "dateCreated": charge.created_at,
                "metadata": {"externalMetadata": charge.metadata},
            }
        return HTTPStatus.NOT_FOUND, pey_error(HTTPStatus.NOT_FOUND, "transaction not found")

    def _qr_transactions(self, qr_id: str) -> tuple[int, JsonObject]:
        charge = self._state.charges.get(qr_id)
        if charge is None or charge.kind != "qr":
            return HTTPStatus.NOT_FOUND, pey_error(HTTPStatus.NOT_FOUND, "qr not found")
        items = [transaction_body(p) for p in self._state.payments.values() if p.charge.ref == qr_id]
        return HTTPStatus.OK, {"items": items, "nextToken": None}

    def pay(self, body: JsonObject) -> JsonObject:
        provider_ref, amount = body.get("provider_ref"), body.get("amount")
        fee, bank_code = body.get("fee", 0), body.get("bank_code", DEFAULT_BANK_CODE)
        external = body.get("external_metadata")
        if not isinstance(provider_ref, str) or not is_int(amount):
            raise ControlError(HTTPStatus.BAD_REQUEST, "provider_ref (str) and amount (int, minor units) are required")
        if not is_int(fee):
            raise ControlError(HTTPStatus.BAD_REQUEST, "fee must be an int (minor units)")
        if bank_code is not None and not is_int(bank_code):
            raise ControlError(HTTPStatus.BAD_REQUEST, "bank_code must be an int, or null to leave it out")
        if external is not None and not isinstance(external, dict):
            raise ControlError(HTTPStatus.BAD_REQUEST, "external_metadata must be an object")
        options = self._delivery_options(body)
        with self._lock:
            charge = self._state.charges.get(provider_ref)
            if charge is None:
                raise ControlError(HTTPStatus.NOT_FOUND, f"no charge {provider_ref}")
            if charge.kind == "pn" and provider_ref in self._state.payments:
                raise ControlError(HTTPStatus.CONFLICT, f"push {provider_ref} is already paid")
            # pey sends late money like any other; `late` only dates it after the charge expired.
            date_paid = charge.created_at + charge.expiration + 1 if body.get("late") else int(time.time())
            payment = Payment(
                transaction_id=charge.ref if charge.kind == "pn" else new_transaction_id(),
                charge=charge,
                amount_minor=amount,
                fee_minor=fee,
                date_paid=date_paid,
                tracking_key=digits(TRACKING_KEY_DIGITS),
                bank_code=bank_code,
            )
            self._state.payments[payment.transaction_id] = payment
        webhook = webhook_body(payment, charge.metadata if external is None else external)
        return {
            "transaction_id": payment.transaction_id,
            "tracking_key": payment.tracking_key,
            "date_paid": payment.date_paid,
            **self._deliver(json.dumps(webhook), options),
        }

    def deliver(self, body: JsonObject) -> JsonObject:
        """Signs `body["body"]` (a string sent as is, or JSON to serialize) and POSTs it to the target.

        With `"send": false` the signed delivery is only returned, for a test to post (or tamper) itself.
        """
        raw = body.get("body")
        payload = raw if isinstance(raw, str) else json.dumps(raw)
        return self._deliver(payload, self._delivery_options(body))

    def _delivery_options(self, body: JsonObject) -> DeliveryOptions:
        url = body.get("webhook_url")
        url = self._webhook_url if url is None else url
        if not isinstance(url, str) or not is_webhook_url(url):
            raise ControlError(
                HTTPStatus.BAD_REQUEST, "webhook_url must be an http(s) URL (or start with --webhook-url)"
            )
        webhook_id = body.get("webhook_id")
        webhook_id = f"msg_{uuid.uuid4().hex}" if webhook_id is None else webhook_id
        if not isinstance(webhook_id, str) or not webhook_id:
            raise ControlError(HTTPStatus.BAD_REQUEST, "webhook_id must be a non-empty string")
        send = body.get("send")
        send = True if send is None else send
        if not isinstance(send, bool):
            raise ControlError(HTTPStatus.BAD_REQUEST, "send must be a boolean")
        return DeliveryOptions(url, webhook_id, signed_at(body.get("timestamp")), send)

    def _deliver(self, payload: str, options: DeliveryOptions) -> JsonObject:
        signed = sign(payload.encode(), self._secret(), options.webhook_id, options.signed_at)
        headers = {"content-type": "application/json"} | signed
        delivery: JsonObject = {"url": options.url, "headers": headers, "body": payload}
        if not options.send:
            return {"delivery": delivery, "response": None}
        request = urllib.request.Request(options.url, data=payload.encode(), headers=headers, method="POST")
        try:
            status, content_type, text = post(request)
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError, UnicodeError) as error:
            raise ControlError(HTTPStatus.BAD_GATEWAY, f"delivery to {options.url} failed: {error!r}") from error
        return {
            "delivery": delivery,
            "response": {
                "status": status,
                "content_type": content_type,
                "body": parse_json(text.decode(errors="replace")),
            },
        }

    def fail_next(self, body: JsonObject) -> None:
        status, times = body.get("status"), body.get("times", 1)
        if not is_int(status) or not HTTPStatus.BAD_REQUEST <= status <= MAX_HTTP_STATUS:
            raise ControlError(HTTPStatus.BAD_REQUEST, "status must be an int from 400 to 599")
        if not is_int(times) or times < 1:
            raise ControlError(HTTPStatus.BAD_REQUEST, "times must be a positive int")
        with self._lock:
            self._state.failures.extend([status] * times)

    def clear_failures(self) -> None:
        with self._lock:
            self._state.failures.clear()

    def stall_next(self) -> None:
        with self._lock:
            self._state.stall_next = True

    def release(self) -> None:
        with self._lock:
            self._state.stall_next = False
            stalled, self._state.stalled = self._state.stalled, []
        for gate in stalled:
            gate.set()

    def reset(self) -> None:
        self.release()
        with self._lock:
            self._state = State()

    def requests(self) -> JsonObject:
        with self._lock:
            return {"requests": [asdict(request) for request in self._state.requests]}

    def _secret(self) -> str:
        return self._secret_file.read_text().strip()


def is_webhook_url(url: str) -> bool:
    """An absolute http(s) URL that urllib can send to.

    ASCII only (http.client encodes the request line as ASCII), no whitespace or controls, a valid port,
    and a host the idna codec accepts (the socket layer encodes it so; `a..b` has an empty label).
    """
    if not url.isascii() or URL_FORBIDDEN_CHARS.search(url):
        return False
    try:
        parts = urlsplit(url)
        _ = parts.port  # raises ValueError when the port is out of range
        host = parts.hostname
        if not host:
            return False
        host.encode("idna")  # raises UnicodeError, a ValueError, for an empty or overlong label
    except ValueError:
        return False
    return parts.scheme in WEBHOOK_SCHEMES


def signed_at(timestamp: object) -> datetime:
    """The signing instant: now, or the epoch seconds a test asked for (to probe timestamp tolerance)."""
    if timestamp is None:
        return datetime.now(UTC)
    if not is_int(timestamp):
        raise ControlError(HTTPStatus.BAD_REQUEST, "timestamp must be an int (epoch seconds)")
    try:
        return datetime.fromtimestamp(timestamp, UTC)
    except (OverflowError, OSError, ValueError) as error:
        raise ControlError(HTTPStatus.BAD_REQUEST, f"timestamp {timestamp} is not a date") from error


def post(request: urllib.request.Request) -> tuple[int, str | None, bytes]:
    """Status, content type and body of the answer, error statuses included."""
    try:
        with urllib.request.urlopen(request, timeout=DELIVERY_TIMEOUT_SECONDS) as response:
            return response.status, response.headers.get("content-type"), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("content-type"), error.read()


def transaction_body(payment: Payment) -> JsonObject:
    return {
        "id": payment.transaction_id,
        "status": "PAID",
        "amount": pesos(payment.amount_minor + payment.fee_minor),
        "amountBreakdown": {"base": pesos(payment.amount_minor), "tip": 0, "fee": pesos(payment.fee_minor)},
        "currency": CURRENCY,
        "paymentMethod": "CODI",
        "payableType": "API_CODI_PN" if payment.charge.kind == "pn" else "API_CODI_QR",
        "dateCreated": payment.charge.created_at,
        "datePaid": payment.date_paid,
        "metadata": payment_metadata(payment, payment.charge.metadata),
    }


def payment_metadata(payment: Payment, external: JsonObject) -> PaymentMetadata:
    metadata: PaymentMetadata = {
        "clabe": SYNTHETIC_CLABE,
        "accountType": CODI_ACCOUNT_TYPE,
        "description": payment.charge.concept,
        "trackingKey": payment.tracking_key,
        "externalMetadata": external,
    }
    if payment.bank_code is not None:
        metadata["bankCode"] = payment.bank_code
    return metadata


def webhook_body(payment: Payment, external: JsonObject) -> PeyWebhook:
    body: PeyWebhook = {
        "amount": pesos(payment.amount_minor + payment.fee_minor),
        "apiKeyId": API_KEY_ID,
        "concept": payment.charge.concept,
        "datePaid": payment.date_paid,
        "metadata": payment_metadata(payment, external),
        "numRef": payment.charge.num_ref,
        "transactionId": payment.transaction_id,
        "type": "codi.pn.payment_received",
    }
    if payment.charge.kind == "qr":
        body["bankAccountId"] = BANK_ACCOUNT_ID
        body["codiQrId"] = payment.charge.ref
        body["type"] = "codi.qr.payment_received"
    return body


def parse_json(text: str) -> object:
    try:
        return json.loads(text)
    except ValueError:
        return text


class Handler(BaseHTTPRequestHandler):
    server: PeyServer

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def _handle(self, method: str) -> None:
        pey = self.server.pey
        path = urlsplit(self.path).path
        try:
            body = self._json_body()
            if path.startswith("/_control/"):
                self._send(HTTPStatus.OK, self._control(pey, method, path, body or {}))
            else:
                authorized = (self.headers.get("authorization") or "").startswith("Bearer ")
                self._send(*pey.api(method, path, body, authorized))
        except ControlError as error:
            self._send(error.status, {"error": str(error)})

    def _control(self, pey: FakePey, method: str, path: str, body: JsonObject) -> JsonObject:
        if method == "GET" and path == "/_control/requests":
            return pey.requests()
        if method != "POST":
            raise ControlError(HTTPStatus.METHOD_NOT_ALLOWED, f"{method} {path}")
        match path:
            case "/_control/pay":
                return pey.pay(body)
            case "/_control/deliver":
                return pey.deliver(body)
            case "/_control/fail-next":
                pey.fail_next(body)
            case "/_control/clear-failures":
                pey.clear_failures()
            case "/_control/stall-next":
                pey.stall_next()
            case "/_control/release":
                pey.release()
            case "/_control/reset":
                pey.reset()
            case _:
                raise ControlError(HTTPStatus.NOT_FOUND, f"no control endpoint {path}")
        return {"ok": True}

    def _json_body(self) -> JsonObject | None:
        declared = self.headers.get("content-length") or "0"
        if not (declared.isascii() and declared.isdigit()):
            raise ControlError(HTTPStatus.BAD_REQUEST, "content-length must be a non-negative integer")
        # Checked before int(): past 4300 digits int() raises (the int max str digits limit).
        if len(declared) > MAX_CONTENT_LENGTH_DIGITS:
            raise ControlError(
                HTTPStatus.BAD_REQUEST, f"content-length has more than {MAX_CONTENT_LENGTH_DIGITS} digits"
            )
        length = int(declared)
        if length == 0:
            return None
        if length > MAX_BODY_BYTES:
            raise ControlError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body too large")
        try:
            parsed = json.loads(self.rfile.read(length))
        except ValueError as error:
            raise ControlError(HTTPStatus.BAD_REQUEST, f"body is not JSON: {error}") from error
        if not isinstance(parsed, dict):
            raise ControlError(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
        return parsed

    def _send(self, status: int, body: JsonObject) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class PeyServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], pey: FakePey) -> None:
        super().__init__(address, Handler)
        self.pey = pey


def serve(host: str, port: int, secret_file: Path, webhook_url: str | None) -> None:
    if not secret_file.read_text().strip():
        raise SystemExit(f"{secret_file} is empty")
    server = PeyServer((host, port), FakePey(secret_file, webhook_url))
    print(f"fake pey listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
