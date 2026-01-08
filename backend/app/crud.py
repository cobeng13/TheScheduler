from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, time_utils
from .schemas import ScheduleEntryCreate, ScheduleEntryUpdate


def create_schedule_entry(db: Session, entry: ScheduleEntryCreate) -> models.ScheduleEntry:
    if time_utils.is_tba(entry.time_lpu) or time_utils.is_tba(entry.days):
        normalized_lpu = "TBA"
        time_24 = None
        start_minutes = None
        end_minutes = None
        normalized_days = "TBA"
    else:
        normalized_lpu, time_24, start_minutes, end_minutes = time_utils.parse_time_lpu(
            entry.time_lpu
        )
        normalized_days = time_utils.normalize_days_string(entry.days)
        if not normalized_days:
            raise ValueError("Invalid Days. Example: M,W,F")
    model = models.ScheduleEntry(
        program=entry.program,
        section=entry.section,
        course_code=entry.course_code,
        course_description=entry.course_description,
        units=entry.units,
        hours=entry.hours,
        time_lpu=normalized_lpu,
        time_24=time_24,
        days=normalized_days,
        room=entry.room,
        faculty=entry.faculty,
        start_minutes=start_minutes,
        end_minutes=end_minutes,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


def update_schedule_entry(
    db: Session, entry_id: int, entry: ScheduleEntryUpdate
) -> models.ScheduleEntry:
    model = db.get(models.ScheduleEntry, entry_id)
    if model is None:
        raise ValueError("Schedule entry not found")
    if time_utils.is_tba(entry.time_lpu) or time_utils.is_tba(entry.days):
        normalized_lpu = "TBA"
        time_24 = None
        start_minutes = None
        end_minutes = None
        normalized_days = "TBA"
    else:
        normalized_lpu, time_24, start_minutes, end_minutes = time_utils.parse_time_lpu(
            entry.time_lpu
        )
        normalized_days = time_utils.normalize_days_string(entry.days)
        if not normalized_days:
            raise ValueError("Invalid Days. Example: M,W,F")
    model.program = entry.program
    model.section = entry.section
    model.course_code = entry.course_code
    model.course_description = entry.course_description
    model.units = entry.units
    model.hours = entry.hours
    model.time_lpu = normalized_lpu
    model.time_24 = time_24
    model.days = normalized_days
    model.room = entry.room
    model.faculty = entry.faculty
    model.start_minutes = start_minutes
    model.end_minutes = end_minutes
    db.commit()
    db.refresh(model)
    return model


def delete_schedule_entry(db: Session, entry_id: int) -> None:
    model = db.get(models.ScheduleEntry, entry_id)
    if model is None:
        raise ValueError("Schedule entry not found")
    db.delete(model)
    db.commit()


def list_schedule_entries(db: Session) -> list[models.ScheduleEntry]:
    return list(db.scalars(select(models.ScheduleEntry).order_by(models.ScheduleEntry.id)))


def get_schedule_entry(db: Session, entry_id: int) -> models.ScheduleEntry | None:
    return db.get(models.ScheduleEntry, entry_id)


def create_named_entity(db: Session, model_cls, name: str):
    instance = model_cls(name=name)
    db.add(instance)
    db.commit()
    db.refresh(instance)
    return instance


def list_named_entities(db: Session, model_cls):
    return list(db.scalars(select(model_cls).order_by(model_cls.name)))


def get_app_settings(db: Session) -> models.AppSettings | None:
    return db.get(models.AppSettings, 1)


def set_app_settings(db: Session, settings_json: str) -> models.AppSettings:
    instance = db.get(models.AppSettings, 1)
    if instance is None:
        instance = models.AppSettings(id=1, settings_json=settings_json)
        db.add(instance)
    else:
        instance.settings_json = settings_json
    db.commit()
    db.refresh(instance)
    return instance
