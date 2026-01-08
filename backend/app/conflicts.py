from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .time_utils import normalize_days, overlap


def _is_tba(value: str | None) -> bool:
    if value is None:
        return True
    cleaned = value.strip().lower()
    return cleaned in {"", "tba"}


def _matches_ignore(value: str, ignore_list: list[str], contains: bool) -> bool:
    target = value.strip().lower()
    for item in ignore_list:
        candidate = item.strip().lower()
        if not candidate:
            continue
        if contains and candidate in target:
            return True
        if not contains and candidate == target:
            return True
    return False


def find_conflicts(
    db: Session,
    ignore_faculty: bool = False,
    ignore_room: bool = False,
    ignore_tba: bool = False,
    ignore_faculty_list: list[str] | None = None,
    ignore_room_list: list[str] | None = None,
    contains_faculty: bool = False,
    contains_room: bool = False,
) -> list[dict]:
    entries = list(db.scalars(select(models.ScheduleEntry)))
    conflicts: list[dict] = []
    ignore_faculty_list = ignore_faculty_list or []
    ignore_room_list = ignore_room_list or []
    for entry in entries:
        if entry.start_minutes is None or entry.end_minutes is None:
            continue
        if ignore_tba and (_is_tba(entry.time_lpu) or _is_tba(entry.days)):
            continue
        entry_days = normalize_days(entry.days)
        for other in entries:
            if entry.id == other.id:
                continue
            if other.start_minutes is None or other.end_minutes is None:
                continue
            if ignore_tba and (_is_tba(other.time_lpu) or _is_tba(other.days)):
                continue
            if not overlap(entry.start_minutes, entry.end_minutes, other.start_minutes, other.end_minutes):
                continue
            if not entry_days.intersection(normalize_days(other.days)):
                continue
            if not ignore_room:
                if _matches_ignore(entry.room, ignore_room_list, contains_room) or _matches_ignore(
                    other.room, ignore_room_list, contains_room
                ):
                    pass
                elif entry.room == other.room:
                    conflicts.append({
                        "entry_id": entry.id,
                        "conflicts_with": other.id,
                        "conflict_type": "room",
                    })
            if not ignore_faculty:
                if _matches_ignore(entry.faculty, ignore_faculty_list, contains_faculty) or _matches_ignore(
                    other.faculty, ignore_faculty_list, contains_faculty
                ):
                    pass
                elif entry.faculty == other.faculty:
                    conflicts.append({
                        "entry_id": entry.id,
                        "conflicts_with": other.id,
                        "conflict_type": "faculty",
                    })
    return conflicts


def conflicts_for_entry(db: Session, entry_id: int) -> list[dict]:
    conflicts = [c for c in find_conflicts(db) if c["entry_id"] == entry_id]
    return conflicts
