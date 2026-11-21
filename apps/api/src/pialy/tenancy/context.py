"""Who acts, and for which business. Every tenant query runs with one (spec §5b)."""

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class OwnerActor:
    user_id: UUID


@dataclass(frozen=True, slots=True)
class StaffActor:
    """Unused until layer 3 (roles and invitations)."""

    user_id: UUID


@dataclass(frozen=True, slots=True)
class PublicActor:
    """A customer on the public page; customers have no account."""


@dataclass(frozen=True, slots=True)
class SystemActor:
    """A background job, such as the sweeper, working inside one business."""

    job: str


Actor = OwnerActor | StaffActor | PublicActor | SystemActor


@dataclass(frozen=True, slots=True)
class TenantContext:
    business_id: UUID
    actor: Actor
