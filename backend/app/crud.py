from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import conflicts, models, time_utils
from .schemas import ScheduleEntryCreate, ScheduleEntryUpdate


PLACEHOLDER_ENTITY_NAMES = {
    models.Section: {"no section", "no sections", "no section yet", "no sections yet"},
    models.Faculty: {"no faculty", "no faculty yet"},
    models.Room: {"no room", "no rooms", "no room yet", "no rooms yet"},
}


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
    _raise_for_section_conflict(db, 0, model)
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
    _raise_for_section_conflict(db, entry_id, model)
    db.commit()
    db.refresh(model)
    return model


def _raise_for_section_conflict(
    db: Session, entry_id: int, candidate: models.ScheduleEntry
) -> None:
    section_conflicts = [
        conflict
        for conflict in conflicts.conflicts_for_candidate(
            db,
            entry_id,
            SimpleNamespace(
                section=candidate.section,
                time_lpu=candidate.time_lpu,
                days=candidate.days,
                start_minutes=candidate.start_minutes,
                end_minutes=candidate.end_minutes,
                room=candidate.room,
                faculty=candidate.faculty,
            ),
        )
        if conflict["conflict_type"] == "section"
    ]
    if section_conflicts:
        raise ValueError("Section has another class at the same time")


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


def _schedule_field_for_entity(model_cls):
    if model_cls is models.Section:
        return models.ScheduleEntry.section
    if model_cls is models.Faculty:
        return models.ScheduleEntry.faculty
    if model_cls is models.Room:
        return models.ScheduleEntry.room
    raise ValueError("Unsupported entity type")


def _has_merge_conflict(
    entries: list[models.ScheduleEntry],
    model_cls,
    source_name: str,
    target_name: str,
) -> bool:
    field_name = _schedule_field_for_entity(model_cls).key
    simulated = []
    for entry in entries:
        simulated.append(
            {
                "id": entry.id,
                "value": target_name if getattr(entry, field_name) == source_name else getattr(entry, field_name),
                "start_minutes": entry.start_minutes,
                "end_minutes": entry.end_minutes,
                "days": time_utils.normalize_days(entry.days),
            }
        )
    for index, left in enumerate(simulated):
        if left["value"] != target_name:
            continue
        if left["start_minutes"] is None or left["end_minutes"] is None:
            continue
        for right in simulated[index + 1:]:
            if right["value"] != target_name:
                continue
            if right["start_minutes"] is None or right["end_minutes"] is None:
                continue
            if not left["days"].intersection(right["days"]):
                continue
            if time_utils.overlap(
                left["start_minutes"],
                left["end_minutes"],
                right["start_minutes"],
                right["end_minutes"],
            ):
                return True
    return False


def update_named_entity(db: Session, model_cls, entity_id: int, name: str):
    instance = db.get(model_cls, entity_id)
    if instance is None:
        raise ValueError("Entity not found")
    old_name = instance.name
    instance.name = name
    schedule_field = _schedule_field_for_entity(model_cls)
    entries = db.scalars(select(models.ScheduleEntry).where(schedule_field == old_name))
    for entry in entries:
        setattr(entry, schedule_field.key, name)
    db.commit()
    db.refresh(instance)
    return instance


def merge_named_entity(db: Session, model_cls, source_id: int, target_name: str):
    if model_cls not in {models.Faculty, models.Room}:
        raise ValueError("Merge is only available for faculty and rooms")
    source = db.get(model_cls, source_id)
    if source is None:
        raise ValueError("Entity not found")
    target = db.scalar(
        select(model_cls).where(func.lower(model_cls.name) == target_name.strip().lower())
    )
    if target is None:
        raise ValueError("Merge target not found")
    if target.id == source.id:
        return source

    entries = list(db.scalars(select(models.ScheduleEntry)))
    if _has_merge_conflict(entries, model_cls, source.name, target.name):
        raise ValueError(f"Merging would create {model_cls.__name__.lower()} conflicts")

    schedule_field = _schedule_field_for_entity(model_cls)
    for entry in entries:
        if getattr(entry, schedule_field.key) == source.name:
            setattr(entry, schedule_field.key, target.name)
    db.delete(source)
    db.commit()
    db.refresh(target)
    return target


def delete_named_entity(db: Session, model_cls, entity_id: int, force: bool = False) -> None:
    instance = db.get(model_cls, entity_id)
    if instance is None:
        raise ValueError("Entity not found")
    schedule_field = _schedule_field_for_entity(model_cls)
    matching_entries = list(
        db.scalars(select(models.ScheduleEntry).where(schedule_field == instance.name))
    )
    if matching_entries and not force:
        raise ValueError(f"{model_cls.__name__} has scheduled classes")
    for entry in matching_entries:
        db.delete(entry)
    db.delete(instance)
    db.commit()


def list_named_entities(db: Session, model_cls):
    return list(db.scalars(select(model_cls).order_by(model_cls.name)))


def remove_unused_placeholder_entities(db: Session) -> None:
    real_sections = {
        name.lower()
        for name in db.scalars(select(models.ScheduleEntry.section).distinct())
        if name and name.strip()
    }
    real_faculty = {
        name.lower()
        for name in db.scalars(select(models.ScheduleEntry.faculty).distinct())
        if name and name.strip()
    }
    real_rooms = {
        name.lower()
        for name in db.scalars(select(models.ScheduleEntry.room).distinct())
        if name and name.strip()
    }
    usage = {
        models.Section: real_sections,
        models.Faculty: real_faculty,
        models.Room: real_rooms,
    }
    changed = False
    for model_cls, placeholder_names in PLACEHOLDER_ENTITY_NAMES.items():
        has_real_entities = any(name not in placeholder_names for name in usage[model_cls])
        if not has_real_entities:
            continue
        placeholders = list(
            db.scalars(
                select(model_cls).where(func.lower(model_cls.name).in_(placeholder_names))
            )
        )
        for placeholder in placeholders:
            if placeholder.name.strip().lower() not in usage[model_cls]:
                db.delete(placeholder)
                changed = True
    if changed:
        db.commit()


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
