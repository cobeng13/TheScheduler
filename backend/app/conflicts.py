from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .time_utils import normalize_days, overlap


def find_conflicts(db: Session) -> list[dict]:
    entries = list(db.scalars(select(models.ScheduleEntry)))
    conflicts: list[dict] = []
    for entry in entries:
        entry_days = normalize_days(entry.days)
        for other in entries:
            if entry.id == other.id:
                continue
            if not overlap(entry.start_minutes, entry.end_minutes, other.start_minutes, other.end_minutes):
                continue
            if not entry_days.intersection(normalize_days(other.days)):
                continue
            if entry.room == other.room:
                conflicts.append({
                    "entry_id": entry.id,
                    "conflicts_with": other.id,
                    "conflict_type": "room",
                })
            if entry.faculty == other.faculty:
                conflicts.append({
                    "entry_id": entry.id,
                    "conflicts_with": other.id,
                    "conflict_type": "faculty",
                })
    return conflicts


def conflicts_for_entry(db: Session, entry_id: int) -> list[dict]:
    conflicts = [c for c in find_conflicts(db) if c["entry_id"] == entry_id]
    return conflicts
