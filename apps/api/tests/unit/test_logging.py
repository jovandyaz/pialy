import json
import logging
import time
import uuid
from collections.abc import Iterator

import pytest

from pialy.observability.logging import (
    bind,
    bind_route,
    configure_logging,
    log_event,
    redact,
    redact_value,
    request_id,
    start_request_context,
)

PHONE = "5512345678"
EMAIL = "a@b.mx"
TOKEN = "3f9a" * 8  # 32 hex characters
CLABE = "123456789012345678"
BOOKING_TOKEN = "Zx9QbW1kT2tlbl9TZWNyZXQ"
UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"


@pytest.fixture(autouse=True)
def _restore_root(json_logs: None) -> None:
    return None


@pytest.fixture(autouse=True)
def _fresh_bound_fields() -> Iterator[None]:
    """`bind` outside a request writes to the test thread's context: clear it around each test."""
    start_request_context()
    yield
    start_request_context()


@pytest.fixture
def context() -> Iterator[None]:
    token = request_id.set("req-12345678")
    yield
    request_id.reset(token)


def lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line]


def test_redacts_phone_email_token_key_and_clabe(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    secret_text = f"tel {PHONE} mail {EMAIL} tok {TOKEN} clabe {CLABE}"
    try:
        raise ValueError(secret_text)
    except ValueError as error:
        logging.getLogger("x").error("failed: %s", secret_text, exc_info=error)
    out = capsys.readouterr().out
    for leaked in (PHONE, EMAIL, TOKEN, CLABE, "123456789012"):
        assert leaked not in out
    assert "tel" in out
    assert "[digits]" in out
    assert "[email]" in out
    assert "[token]" in out


def test_redacts_exception_text_with_traceback(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    try:
        raise RuntimeError(f"boom {PHONE}")
    except RuntimeError:
        logging.getLogger("x").exception("unhandled")
    [line] = lines(capsys)
    assert PHONE not in json.dumps(line)
    assert "RuntimeError" in str(line["exc"])


def test_truncates_booking_token_in_url_to_4_chars() -> None:
    assert redact(f"GET /api/bookings/{BOOKING_TOKEN}/events 200") == (
        "GET /api/bookings/Zx9Q…/events 200"
    )
    assert redact(f"GET /c/{BOOKING_TOKEN}?x=1") == "GET /c/Zx9Q…?x=1"
    assert redact("GET /api/slots?date=2026-11-15") == "GET /api/slots?date=2026-11-15"


def test_every_line_carries_request_id_and_business_id(
    capsys: pytest.CaptureFixture[str], context: None
) -> None:
    configure_logging("INFO")
    bind(business_id="biz-1", route="/api/slots")
    logging.getLogger("x").info("one")
    log_event("payment.applied", amount=1, currency="MXN")
    first, second = lines(capsys)
    for line in (first, second):
        assert line["request_id"] == "req-12345678"
        assert line["business_id"] == "biz-1"
        assert line["route"] == "/api/slots"
    assert second["event"] == "payment.applied"
    assert second["amount"] == 1
    assert second["message"] == "payment.applied"


def test_event_fields_are_redacted_and_cannot_override_base_keys(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    log_event("x.happened", note=f"call {PHONE}", level="DEBUG")
    [line] = lines(capsys)
    assert PHONE not in json.dumps(line)
    assert line["level"] == "INFO"


def test_bound_fields_cannot_override_the_base_keys(
    capsys: pytest.CaptureFixture[str], context: None
) -> None:
    configure_logging("INFO")
    start_request_context()
    bind(
        ts="forged",
        level="DEBUG",
        logger="forged",
        message="forged",
        request_id="forged",
        event="forged",
        exc="forged",
        stack="forged",
        business_id="biz-1",
    )
    logging.getLogger("real").info("hello")
    [line] = lines(capsys)
    assert line["level"] == "INFO"
    assert line["logger"] == "real"
    assert line["message"] == "hello"
    assert line["request_id"] == "req-12345678"
    assert line["ts"] != "forged"
    assert not {"event", "exc", "stack"} & set(line)
    assert line["business_id"] == "biz-1"  # business_id and route stay bindable


def test_bound_fields_and_the_route_are_redacted_too(
    capsys: pytest.CaptureFixture[str], context: None
) -> None:
    configure_logging("INFO")
    start_request_context()
    bind(business_id=UUID, user=EMAIL, note=f"call {PHONE}")
    bind_route(lambda: f"/stores/{EMAIL}/boom")
    logging.getLogger("x").info("hello")
    [line] = lines(capsys)
    assert line["business_id"] == UUID  # identifiers survive
    assert line["user"] == "[email]"
    assert line["note"] == "call [digits]"
    assert line["route"] == "/stores/[email]/boom"
    assert EMAIL not in json.dumps(line)
    assert PHONE not in json.dumps(line)


def test_a_bound_route_override_is_redacted_too(
    capsys: pytest.CaptureFixture[str], context: None
) -> None:
    configure_logging("INFO")
    start_request_context()
    bind(route=f"/api/slots?phone={PHONE}")
    logging.getLogger("x").info("hello")
    [line] = lines(capsys)
    assert line["route"] == "/api/slots?phone=[digits]"


def test_numeric_event_fields_are_redacted_too(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    log_event(
        "x.happened",
        phone=int(PHONE),
        account=int(CLABE),
        big_float=1234567890123456.0,
        phone_float=float(PHONE),
        count=7,
        ratio=0.5,
        flag=True,
        nothing=None,
    )
    [line] = lines(capsys)
    assert line["phone"] == "[digits]"
    assert line["account"] == "[digits]"
    assert line["big_float"] == "[digits]"  # a 17-digit chain, ".0" included
    assert line["phone_float"] == "[digits]"  # an 11-digit chain, ".0" included
    assert line["count"] == 7
    assert line["ratio"] == 0.5
    assert line["flag"] is True
    assert line["nothing"] is None
    assert PHONE not in json.dumps(line)
    assert "1234567890123456" not in json.dumps(line)


def test_redact_value_keeps_scalars_and_redacts_the_text_of_other_objects() -> None:
    class Holder:
        def __str__(self) -> str:
            return f"mail {EMAIL}"

    assert redact_value(int(PHONE)) == "[digits]"
    assert redact_value(1234567890123456.0) == "[digits]"
    assert redact_value(float(PHONE)) == "[digits]"
    assert redact_value(7) == 7
    assert redact_value(0.5) == 0.5
    assert redact_value(True) is True
    assert redact_value(None) is None
    assert redact_value(f"call {PHONE}") == "call [digits]"
    assert redact_value(Holder()) == "mail [email]"  # json would stringify it with default=str
    same = uuid.UUID(UUID)
    assert redact_value(same) is same  # an identifier stays as it is


class RaisingStr:
    def __str__(self) -> str:
        raise RuntimeError("no text for you")


def test_redact_value_never_raises_on_odd_values() -> None:
    assert redact_value(RaisingStr()) == "[unrepresentable]"
    assert redact_value(10**5000) == "[unrepresentable]"  # over Python's int-to-str digit limit
    assert redact_value(-(10**5000)) == "[unrepresentable]"


def test_odd_event_field_values_do_not_raise_into_the_caller(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    log_event("x.happened", big=10**5000, note="kept")
    [line] = lines(capsys)
    assert line["message"] == "x.happened"  # not the whole-record fallback
    assert line["big"] == "[unrepresentable]"
    assert line["note"] == "kept"


def test_level_filters_and_rejects_unknown(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("warning")
    logging.getLogger("x").info("hidden")
    assert capsys.readouterr().out == ""
    with pytest.raises(ValueError, match="log level"):
        configure_logging("LOUD")


def test_uvicorn_error_logs_flow_through_the_redacting_handler(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logging.getLogger("uvicorn.error").error(f"failed for {PHONE}")
    [line] = lines(capsys)
    assert PHONE not in json.dumps(line)


def test_uvicorn_access_lines_are_left_to_the_request_middleware(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logging.getLogger("uvicorn.access").info(f"GET /api/bookings/{BOOKING_TOKEN} 200")
    assert capsys.readouterr().out == ""


def test_uuids_survive_redaction_in_text_and_event_fields(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    log_event("payment.applied", booking_id=UUID)
    try:
        raise ValueError(f"no booking {UUID} for {PHONE}")
    except ValueError:
        logging.getLogger("x").exception("failed %s", UUID.upper())
    event, error = lines(capsys)
    assert event["booking_id"] == UUID
    assert error["message"] == f"failed {UUID.upper()}"
    assert f"no booking {UUID} for [digits]" in str(error["exc"])


def test_uuid_shape_does_not_shelter_real_tokens() -> None:
    assert redact(f"tok x{UUID}") == "tok [token]"
    assert redact(f"tok {UUID}-{UUID}") == "tok [token]"
    assert redact(UUID.replace("-", "")) == "[token]"
    assert redact("id 12345678-1234-1234-1234-123456789012") == (
        "id 12345678-1234-1234-1234-123456789012"
    )


@pytest.mark.parametrize(
    "address",
    [f"user+{UUID}@x.mx", f"{UUID}@example.com", f"a.{UUID}@x.mx", f"{UUID.upper()}@x.mx"],
)
def test_emails_containing_a_uuid_are_redacted_whole(address: str) -> None:
    assert redact(f"mail {address} sent") == "mail [email] sent"


@pytest.mark.parametrize(
    "phone",
    [
        "55-1234-5678",
        "55.1234.5678",
        "(55) 1234 5678",
        "(55)1234-5678",
        "55 1234 5678",
        "+52 55 1234 5678",
        "+52-55-1234-5678",
        "52 55 1234 5678",
        "+52 (55) 1234 5678",
        "555 123 4567",
        "555-123-4567",
        "(555) 123-4567",
        "+52 555 123 4567",
        "+521 55 1234 5678",  # legacy mobile prefix, dropped in 2019 but still written
        "+52 1 55 1234 5678",
        "521 55 1234 5678",
        "+521-55-1234-5678",
        "+52 1 (55) 1234 5678",
    ],
)
def test_phones_with_separators_are_redacted(phone: str) -> None:
    assert redact(f"call {phone} now") == "call [digits] now"
    assert redact(f"call {phone}") == "call [digits]"
    assert redact(f"{phone}, then") == "[digits], then"


@pytest.mark.parametrize(
    "text",
    [
        "at 2026-11-21T01:48:00Z",
        "at 2026-11-21T01:48:00.123456+00:00",
        "at 2026-11-21 01:48:00",
        "GET /api/slots?date=2026-11-15",
        "took 123 ms for 4567 rows",
        "version 1.2.3 build 55-1234",
        "status 200 in 12.5 ms",
        f"booking {UUID} ok",
    ],
)
def test_phone_redaction_leaves_ids_timestamps_and_small_numbers(text: str) -> None:
    assert redact(text) == text


@pytest.mark.parametrize(
    "account",
    [
        "0121 8001 2345 6789 12",  # CLABE, 18 digits
        "0121-8001-2345-6789-12",
        "0121.8001.2345.6789.12",
        "012 180 01234567891 2",  # bank, plaza, account, check digit
        "1234 5678 9012 3456",  # card, 16 digits
        "1234-5678-9012-3456",
        "1234 567890 12345",  # 15 digits
        "1234 5678 9012 3456 789",  # 19 digits
        "12345:67890:12345678",  # colons
        "12345|67890|12345678",  # pipes
        "0121 | 8001 | 2345 | 6789 | 12",
        "(012) 180 01234567891 2",
        "012(180)012345678912",
    ],
)
def test_spaced_account_and_card_numbers_are_redacted_whole(account: str) -> None:
    assert redact(f"pay {account} now") == "pay [digits] now"
    assert redact(f"pay {account}.") == "pay [digits]."
    assert redact(f"{account}, then") == "[digits], then"


@pytest.mark.parametrize(
    "text, expected",
    [
        ("amount 12 0121 8001 2345 6789 12 ok", "amount [digits] ok"),  # 20 digits
        ("1234 5678 9012 3456 7890", "[digits]"),
        ("55 1234 5678 55 8765 4321", "[digits]"),  # two phones in a row
        ("ids " + " ".join(["12345"] * 10), "ids [digits]"),  # 50 digits
        ("2026-11-15 12 0121 8001 2345 6789 12", "[digits]"),  # a date does not shelter the rest
    ],
)
def test_digit_chains_of_15_or_more_digits_are_redacted_whole(text: str, expected: str) -> None:
    assert redact(text) == expected


@pytest.mark.parametrize(
    "account",
    [
        "4111  1111  1111  1111",  # double spaces
        "4111,1111,1111,1111",
        "4111, 1111, 1111, 1111",
        "4111\t1111\t1111\t1111",
        "4111\xa01111\xa01111\xa01111",  # no-break space
        "0121\xa08001\xa02345\xa06789\xa012",
        "4111\u202f1111\u202f1111\u202f1111",  # narrow no-break space
        "0121/8001/2345/6789/12",
        "0121_8001_2345_6789_12",
        "4111 - 1111 - 1111 - 1111",
        "0121 . 8001 . 2345 . 6789 . 12",
    ],
    ids=[
        "double_space",
        "comma",
        "comma_space",
        "tab",
        "nbsp",
        "clabe_nbsp",
        "narrow_nbsp",
        "slash",
        "underscore",
        "space_dash_space",
        "space_dot_space",
    ],
)
def test_account_and_card_numbers_with_any_common_separator_are_redacted(account: str) -> None:
    assert redact(f"pay {account} now") == "pay [digits] now"
    assert redact(f"{account}!") == "[digits]!"


@pytest.mark.parametrize(
    "phone",
    [
        "5512 3456 78",  # 4-4-2
        "5512-345678",  # 4-6
        "55 12345678",
        "551234 5678",
        "55123 45678",
        "5512.3456.78",
        "555 1234567",
        "55-1234-56-78",  # 1234-56-78 is not a valid date
        "55 12 3456 78",  # nor is day 55
        "5512\xa0345678",
        "5512  3456  78",
        "5512\t345678",
        "+52 5512 3456 78",
        "52 5512 3456 78",
        "+521 5512 3456 78",
        "+52-5512-345678",
        "+52 1 5512 3456 78",  # country code, legacy mobile 1 as its own group, then 4-4-2
        "52 1 5512 3456 78",
        "+52-1-5512-3456-78",
        "+52 1 5512-345678",
        "+52 1 55 12345678",
        "+52 1 5512\xa03456\xa078",
        "55 12 34 56 78",  # pairs
        "+52 55 12 34 56 78",
        "52 55 12 34 56 78",
        "+52 1 55 12 34 56 78",
        "55-12-34-56-78",
        "55.12.34.56.78",
        "55:12:34:56:78",
        "55|1234|5678",
        "(55) 12 34 56 78",
        "(55)12-34-56-78",
        "+52 (55) 12 34 56 78",
        "5 5 1 2 3 4 5 6 7 8",
    ],
)
def test_ten_digit_phones_in_other_groupings_are_redacted(phone: str) -> None:
    assert redact(f"call {phone} now") == "call [digits] now"
    assert redact(f"{phone}, then") == "[digits], then"


@pytest.mark.parametrize(
    "text, expected",
    [
        ("1234-56-78 1234-56-78", "[digits]"),  # not dates: month 56
        ("2026-13-45 2026-13-45", "[digits]"),
        ("pairs 2026-11-15 2026-13-45 end", "pairs [digits] end"),  # one invalid date
        ("x 2026-00-10, 2026-11-00 y", "x [digits] y"),
        ("2026-11-15, 2026-11-16", "2026-11-15, 2026-11-16"),  # valid dates stay readable
        ("2026-12-31 2027-01-01 2027-02-28", "2026-12-31 2027-01-01 2027-02-28"),
    ],
)
def test_the_date_exemption_only_covers_valid_dates(text: str, expected: str) -> None:
    assert redact(text) == expected


def test_spaced_account_next_to_a_phone_redacts_both() -> None:
    assert (
        redact("call 55 1234 5678 or pay 0121 8001 2345 6789 12") == "call [digits] or pay [digits]"
    )


@pytest.mark.parametrize(
    "text",
    [
        "at 2026-11-21T01:48:00Z",
        "at 2026-11-21 01:48:00",
        "at 2026-11-21T01:48:00.123456+00:00",
        "at 2026-11-21T01:48:00.123-05:00",
        "at 2026-11-21T01:48",
        "at 2026-11-21T01:48:00.123456789Z",  # nanoseconds
        "date=2026-11-15",
        "range 2026-11-15 2026-11-16",
        "range 2026-11-15-2026-11-16",
        "days 2026-11-15 2026-11-16 2026-11-17 2026-11-18",
        "days 2026-11-15, 2026-11-16, 2026-11-17",
        "from 2026-11-21T01:48:00Z to 2026-11-22T09:30:00Z",
        "slots 2026-11-21T10:00:00, 2026-11-21T10:30:00, 2026-11-21T11:00:00",
        "interval 2026-11-21T01:48:00/2026-11-22T01:48:00",
        "amount 1,234,567.89 and 1,234.50",  # 9 digits, then 6
        "at 2026-11-21 01:48:00,123 INFO",
        "p50=1234 p95=5678 p99=9012",
        "p50=1234 p95=5678",
        "id 1234 5678",  # 8 digits
        "version 1.2.3.4.5",
        "551234567",  # 9 digits
        "id 12345678-1234-1234-1234-123456789012",
        f"booking {UUID} ok",
    ],
)
def test_digit_rule_leaves_short_numbers_iso_timestamps_and_uuids(text: str) -> None:
    assert redact(text) == text


@pytest.mark.parametrize(
    "text, expected",
    [
        # Flipped by the fail-closed rule: these used to pass as numbers, dates or IPs.
        ("1234 5678 9012 34", "[digits]"),
        ("ip 192.168.1.100 and 10.0.0.12", "ip [digits] and 10.0.0.12"),
        ("ip 192.168.10.12", "ip [digits]"),
        ("ip 192.168.100.200", "ip [digits]"),
        ("amount 12,345,678.90 paid", "amount [digits] paid"),
        ("amount 12.345.678,90 paid", "amount [digits] paid"),
        ("1,234,567,890,123 bytes", "[digits] bytes"),
        ("at 21-11-2026 12:00", "at [digits]"),  # day first: not ISO 8601
        ("ratio 5512.345678", "ratio [digits]"),
        ("bytes 1.234.567.890", "bytes [digits]"),
        ("values 10 20 30 40 50", "values [digits]"),
        ("build 20261121-0148", "build [digits]"),  # ISO basic format is not exempt
    ],
)
def test_any_chain_of_10_or_more_digits_is_redacted(text: str, expected: str) -> None:
    assert redact(text) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        ("at 2026-11-21 25:00:00", "at [digits]"),  # hour 25
        ("at 2026-11-21T01:61:00Z", "at [digits]Z"),  # minute 61
        ("at 2026-11-21T01:48:61Z", "at [digits]Z"),  # second 61
        ("at 2026-11-21T01:48:00.5512345678Z", "at [digits]Z"),  # a 10-digit fraction
        ("at 2026-11-21T01:48:00-25:00", "at [digits]"),  # offset hour 25
        ("2026-11-21 5512345678", "[digits]"),
        ("2026-11-21T01:48:00 5512345678", "[digits]"),
        ("2026-11-21T01:48:00Z 55 12 34 56 78", "2026-11-21T01:48:00Z [digits]"),
        ("2026-11-21T01:48:00+55 12 34 56 78", "2026-11-21T01:48:00+[digits]"),
        ("2026-11-21 (55) 1234 5678", "[digits]"),
    ],
)
def test_the_timestamp_exemption_only_covers_valid_timestamps(text: str, expected: str) -> None:
    assert redact(text) == expected


def test_phone_next_to_a_uuid_is_redacted_and_the_uuid_kept() -> None:
    assert redact(f"{UUID} called 55 1234 5678") == f"{UUID} called [digits]"


# Attacker-controlled text (paths, headers) reaches redact(); each shape is a worst case for one
# of the patterns. The old unbounded email pattern took ~23 s on 100k characters; a linear pass
# takes ~30 ms, so the budget leaves wide room for a slow CI machine and still catches a regression.
REDOS_BUDGET_SECONDS = 1.0
ADVERSARIAL_INPUTS = {
    "letters": "a" * 100_000,
    "dotted": "a." * 50_000,
    "dashed": "a-" * 50_000,
    "plus": "a+" * 50_000,
    "ats": "a@" * 50_000,
    "long_local_parts": ("a" * 70 + "@x.mx ") * 1_400,
    "one_huge_local_part": "a" * 100_000 + "@x.mx",
    "long_locals_without_domain": ("a" * 70 + "@") * 700,
    "huge_domain_label": "a@" + "d" * 100_000,
    "huge_domain_label_with_tld": "a@" + "d" * 100_000 + ".mx",
    "local_64_and_huge_label": "a" * 64 + "@" + "d" * 100_000,
    "locals_and_long_labels": ("a" * 64 + "@" + "d" * 99) * 600,
    "dotted_long_labels": "a@" + ("d" * 300 + ".") * 300,
    "dotted_domain": "a@" + "a." * 50_000,
    "digits": "1" * 100_000,
    "spaced_digits": "1 " * 50_000,
    "dashed_digits": "1-" * 50_000,
    "dotted_digits": "1." * 50_000,
    "tab_digits": "1\t" * 50_000,
    "nbsp_digits": "1\xa0" * 50_000,
    "comma_digits": "1, " * 33_333,
    "double_space_digits": "1  " * 33_333,
    "slash_digits": "1/" * 50_000,
    "underscore_digits": "1_" * 50_000,
    "mixed_separators_digits": ("1" + " .,") * 25_000,
    "too_wide_separators": "1    " * 20_000,
    "many_ten_digit_chains": "5512 3456 78 x " * 6_600,
    "many_prefixed_chains": "+52 5512 3456 78 x " * 5_200,
    "many_five_group_chains": "12 34 56 78 90 x " * 5_800,
    "many_legacy_prefix_chains": "+52 1 5512 3456 78 x " * 4_700,
    "many_invalid_date_pairs": "1234-56-78 1234-56-78 x " * 4_300,
    "many_date_shaped_chains": "2026-11-21 01 x " * 6_600,
    "date_chain": "2026-11-15 " * 9_000,
    "date_chain_with_tail": "2026-11-15 " * 9_000 + "1",
    "colon_digits": "1:" * 50_000,
    "pipe_digits": "1|" * 50_000,
    "paren_digits": "(1)" * 33_333,
    "spaced_paren_digits": "1 ( " * 25_000,
    "new_separators_mixed": ("1" + ":|(") * 25_000,
    "t_digits": "1T" * 50_000,
    "plus_digits": "+1" * 50_000,
    "open_parens": "(" * 100_000,
    "timestamp_chain": "2026-11-21T01:48:00.123456 " * 3_700,
    "timestamp_chain_with_tail": "2026-11-21T01:48:00.123456 " * 3_700 + "1",
    "many_bad_timestamps": "2026-11-21T25:48:00 x " * 4_500,
    "huge_fraction": "2026-11-21T01:48:00." + "1" * 100_000,
    "offset_chain": "2026-11-21T01:48:00-05:00 " * 3_800,
    "path_prefixes": "/c/" * 33_333,
    "path_tokens": "/c/a" * 25_000,
    "uuid_shapes": (UUID[:-1] + "-") * 2_700,
    "just_under_token": ("a" * 31 + " ") * 3_125,
}


@pytest.mark.parametrize("text", ADVERSARIAL_INPUTS.values(), ids=ADVERSARIAL_INPUTS.keys())
def test_redact_stays_linear_on_adversarial_input(text: str) -> None:
    started = time.perf_counter()
    redact(text)
    assert time.perf_counter() - started < REDOS_BUDGET_SECONDS


@pytest.mark.parametrize(
    "address",
    [
        "a.b+c@x.mx",
        "a" * 64 + "@x.mx",
        "x@" + "d" * 63 + ".example.com",
        "a" * 70 + "@x.mx",  # longer than RFC 5321 allows: still redacted whole
        "a.b+" * 60 + "c@x.mx",
        "a" * 5_000 + "@x.mx",
        "bob@" + "d" * 300 + ".mx",  # a label over 255 characters must not leave `bob` behind
        "bob@x." + "d" * 5_000 + ".mx",
        "a" * 70 + "@" + "d" * 300 + ".example.com",
    ],
    ids=[
        "plain",
        "local_64",
        "long_label",
        "local_70",
        "local_dotted_243",
        "local_5000",
        "label_300",
        "second_label_5000",
        "local_70_label_300",
    ],
)
def test_email_pattern_redacts_valid_and_over_long_addresses(address: str) -> None:
    assert redact(f"mail {address} sent") == "mail [email] sent"
    assert redact(f"to={address}") == "to=[email]"


def test_over_long_local_part_does_not_swallow_neighbours() -> None:
    long_address = "a" * 70 + "@x.mx"
    assert redact(f"{long_address} {long_address}") == "[email] [email]"
    assert redact(f"a@x.mx,{long_address};b@y.mx") == "[email],[email];[email]"


@pytest.mark.parametrize(
    "text",
    ["a@b.mx+x@y.mx", "a@b.mx.+x@y.mx", f"a@b.mx+{'c' * 70}@y.mx"],
)
def test_addresses_glued_together_are_each_redacted(text: str) -> None:
    # The second local part starts right where the first domain stops.
    assert redact(text) == "[email][email]"


def test_a_bad_format_call_never_raises_into_the_caller(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logger = logging.getLogger("x")
    logger.info("bad %d", "abc")  # TypeError in msg % args
    logger.info("few %s %s", "one")  # not enough arguments
    logger.info("%(missing)s", {"other": 1})  # KeyError
    first, second, third = lines(capsys)
    assert first["message"] == "bad %d [log format error]"
    assert second["message"] == "few %s %s [log format error]"
    assert third["message"] == "%(missing)s [log format error]"
    assert first["level"] == "INFO"


def test_the_format_error_fallback_drops_args_and_redacts_the_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    logging.getLogger("x").info(f"mail {EMAIL} %d", PHONE)  # args never reach the output
    [line] = lines(capsys)
    assert line["message"] == "mail [email] %d [log format error]"
    assert PHONE not in json.dumps(line)


def test_an_unprintable_message_never_raises_into_the_caller(
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Unprintable:
        def __str__(self) -> str:
            raise RuntimeError("no text for you")

    configure_logging("INFO")
    logging.getLogger("x").info(Unprintable())
    [line] = lines(capsys)
    assert line["message"] == "[unprintable log message] [log format error]"


def test_a_record_whose_exception_cannot_be_formatted_is_replaced_not_raised(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO")
    # A malformed exc_info makes `formatException` raise: the filter must still not.
    logging.getLogger("x").error(f"call {PHONE}", exc_info=(1, 2, 3))  # type: ignore[arg-type]
    logging.getLogger("x").info("next line is fine")
    broken, after = lines(capsys)
    assert broken["message"] == "[log record could not be redacted]"
    assert broken["level"] == "ERROR"
    assert "exc" not in broken
    assert PHONE not in json.dumps(broken)
    assert after["message"] == "next line is fine"


def test_business_id_is_empty_until_bound(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    start_request_context()
    logging.getLogger("x").info("before")
    bind(business_id="biz-1")
    logging.getLogger("x").info("after")
    before, after = lines(capsys)
    assert before["business_id"] == ""
    assert after["business_id"] == "biz-1"
