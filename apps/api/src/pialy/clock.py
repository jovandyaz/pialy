from collections.abc import Callable
from datetime import UTC, datetime

Clock = Callable[[], datetime]


def system_clock() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(UTC)
