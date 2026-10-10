"""Transactional meeting moves and version-bound undo, without schema changes."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from . import conflicts, models, schemas, time_utils

_SNAPSHOT_KEY = secrets.token_bytes(32)


def entry_dict(entry):
    return schemas.ScheduleEntry.model_validate(entry).model_dump(by_alias=True)


def sign(snapshot):
    data = {key: value for key, value in snapshot.items() if key != "signature"}
    return hmac.new(_SNAPSHOT_KEY, json.dumps(data, sort_keys=True).encode(), hashlib.sha256).hexdigest()


def begin_write(db):
    # Acquire SQLite's write lock before reading the expected version or conflicts.
    db.execute(text("BEGIN IMMEDIATE"))


def check_conflicts(db, entry, rules: schemas.MoveConflictSettings, original_conflicts=()):
    found = conflicts.conflicts_for_candidate(
        db, entry.id, entry, **rules.model_dump()
    )
    original = set(original_conflicts)
    found = [item for item in found if (entry.id, item["entry"].id, item["conflict_type"]) not in original]
    if found:
        raise HTTPException(409, detail={
            "message": "Move blocked by a schedule conflict.",
            "conflicts": [{"conflict_type": item["conflict_type"], "entry": entry_dict(item["entry"])} for item in found],
        })


def move(db: Session, entry_id: int, request: schemas.MeetingMove):
    try:
        begin_write(db)
        source = db.get(models.ScheduleEntry, entry_id)
        if source is None:
            raise HTTPException(404, "Class no longer exists.")
        if entry_dict(source) != request.expected.model_dump(by_alias=True):
            raise HTTPException(409, "Class changed. Refresh before moving it.")
        days = list(dict.fromkeys(time_utils.normalize_days_string(source.days).split(",")))
        if request.source_day not in days or source.start_minutes is None or source.end_minutes is None:
            raise HTTPException(422, "Invalid source meeting.")
        if request.destination_day not in {"M", "T", "W", "Th", "F", "Sa", "Su"}:
            raise HTTPException(422, "Invalid destination day.")
        end = request.start_minutes + source.end_minutes - source.start_minutes
        if request.start_minutes < 420 or end > 1260 or end <= request.start_minutes:
            raise HTTPException(422, "Move must fit between 7:00 AM and 9:00 PM.")
        target_section = source.section
        if request.assignment:
            assignment = request.assignment
            entity_type = {"section": models.Section, "faculty": models.Faculty, "room": models.Room}[assignment.kind]
            if not assignment.name.strip() or db.scalar(select(entity_type).where(entity_type.name == assignment.name)) is None:
                raise HTTPException(422, "Destination assignment no longer exists.")
            if assignment.kind == "section":
                target_section = assignment.name
        unchanged_assignment = not request.assignment or getattr(source, request.assignment.kind) == request.assignment.name
        if request.source_day == request.destination_day and source.start_minutes == request.start_minutes and unchanged_assignment:
            db.rollback()
            return {"entries": [], "snapshot": None, "moved_entry_id": entry_id}

        affected = list(db.scalars(select(models.ScheduleEntry)))
        key = lambda row: (row.section.strip().lower(), row.course_code.strip().lower())
        keys = {key(source), (target_section.strip().lower(), source.course_code.strip().lower())}
        affected = [row for row in affected if key(row) in keys]
        before = [entry_dict(source)] + [entry_dict(row) for row in affected if row.id != source.id]
        original_conflicts = sorted({
            (row.id, item["entry"].id, item["conflict_type"])
            for row in affected
            for item in conflicts.conflicts_for_candidate(db, row.id, row, **request.conflict_settings.model_dump())
        })
        if len(days) > 1:
            values = {column.name: getattr(source, column.name) for column in models.ScheduleEntry.__table__.columns if column.name not in {"id", "created_at", "updated_at"}}
            source.days = ",".join(day for day in days if day != request.source_day)
            target = models.ScheduleEntry(**values)
            db.add(target)
        else:
            target = source
        target.days = request.destination_day
        target.start_minutes = request.start_minutes
        target.end_minutes = end
        target.time_lpu = f"{time_utils.format_time_lpu(request.start_minutes)}-{time_utils.format_time_lpu(end)}"
        target.time_24 = f"{time_utils.format_time_24(request.start_minutes)}-{time_utils.format_time_24(end)}"
        if request.assignment:
            setattr(target, request.assignment.kind, request.assignment.name)
        db.flush()
        check_conflicts(db, target, request.conflict_settings)
        affected = list(db.scalars(select(models.ScheduleEntry)))
        affected = [row for row in affected if key(row) in keys]
        for group_key in keys:
            group = [row for row in affected if key(row) == group_key]
            plotted = sum((row.end_minutes - row.start_minutes) / 60 * len(time_utils.normalize_days(row.days)) for row in group if row.start_minutes is not None and row.end_minutes is not None)
            total = request.curriculum_hours.get(group_key[0], round(plotted, 2))
            if total < 0:
                raise HTTPException(422, "Invalid curriculum hours.")
            for row in group:
                row.hours = total
        db.flush()
        after = [entry_dict(row) for row in affected]
        snapshot = {"before": before, "after": after, "conflict_settings": request.conflict_settings.model_dump(), "original_conflicts": original_conflicts}
        snapshot["signature"] = sign(snapshot)
        moved_id = target.id
        db.commit()
        return {"entries": after, "snapshot": snapshot, "moved_entry_id": moved_id}
    except Exception:
        db.rollback()
        raise


def revert(db: Session, entry_id: int, request: schemas.MeetingMoveSnapshot):
    snapshot = request.model_dump(by_alias=True)
    if not hmac.compare_digest(request.signature, sign(snapshot)):
        raise HTTPException(409, "Move snapshot is invalid or expired. Reload the schedule.")
    before = {row["id"]: row for row in snapshot["before"]}
    after = {row["id"]: row for row in snapshot["after"]}
    if entry_id not in before:
        raise HTTPException(422, "Snapshot does not belong to this class.")
    try:
        begin_write(db)
        rows = {row.id: row for row in db.scalars(select(models.ScheduleEntry))}
        keys = {(row["Section"].strip().lower(), row["Course Code"].strip().lower()) for row in list(before.values()) + list(after.values())}
        current = {row.id: entry_dict(row) for row in rows.values() if (row.section.strip().lower(), row.course_code.strip().lower()) in keys}
        if current != after:
            raise HTTPException(409, "Classes changed since the move. Undo is unavailable.")
        for row_id in after.keys() - before.keys():
            db.delete(rows[row_id])
        for row_id, saved in before.items():
            model = rows[row_id]
            values = schemas.ScheduleEntry.model_validate(saved).model_dump()
            for name, value in values.items():
                setattr(model, name, value)
            if model.time_24:
                _, _, model.start_minutes, model.end_minutes = time_utils.parse_time_lpu(model.time_lpu)
        db.flush()
        for row_id in before:
            check_conflicts(db, rows[row_id], request.conflict_settings, request.original_conflicts)
        db.commit()
        return {"entries": list(before.values())}
    except Exception:
        db.rollback()
        raise
