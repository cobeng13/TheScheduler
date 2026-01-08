from __future__ import annotations

import base64
import csv
import io
import shutil
from pathlib import Path
from uuid import uuid4
from typing import List

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import conflicts, crud, models, reports, schemas, time_utils
from .db import DATABASE_PATH, SessionLocal, engine

app = FastAPI(title="Scheduler API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


models.Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.get("/schedule", response_model=List[schemas.ScheduleEntry])
def list_schedule(
    section: str | None = None,
    faculty: str | None = None,
    room: str | None = None,
    db: Session = Depends(get_db),
):
    entries = crud.list_schedule_entries(db)
    if section:
        entries = [entry for entry in entries if entry.section == section]
    if faculty:
        entries = [entry for entry in entries if entry.faculty == faculty]
    if room:
        entries = [entry for entry in entries if entry.room == room]
    return entries


@app.get("/schedule/{entry_id}", response_model=schemas.ScheduleEntry)
def get_schedule(entry_id: int, db: Session = Depends(get_db)):
    entry = crud.get_schedule_entry(db, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Not found")
    return entry


@app.post("/schedule", response_model=schemas.ScheduleEntry)
def create_schedule(entry: schemas.ScheduleEntryCreate, db: Session = Depends(get_db)):
    try:
        return crud.create_schedule_entry(db, entry)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.put("/schedule/{entry_id}", response_model=schemas.ScheduleEntry)
def update_schedule(
    entry_id: int, entry: schemas.ScheduleEntryUpdate, db: Session = Depends(get_db)
):
    try:
        return crud.update_schedule_entry(db, entry_id, entry)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/schedule/{entry_id}")
def delete_schedule(entry_id: int, db: Session = Depends(get_db)):
    try:
        crud.delete_schedule_entry(db, entry_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/sections", response_model=List[schemas.NamedEntity])
def list_sections(db: Session = Depends(get_db)):
    return crud.list_named_entities(db, models.Section)


@app.post("/sections", response_model=schemas.NamedEntity)
def create_section(payload: schemas.NamedEntityCreate, db: Session = Depends(get_db)):
    return crud.create_named_entity(db, models.Section, payload.name)


@app.get("/faculty", response_model=List[schemas.NamedEntity])
def list_faculty(db: Session = Depends(get_db)):
    return crud.list_named_entities(db, models.Faculty)


@app.post("/faculty", response_model=schemas.NamedEntity)
def create_faculty(payload: schemas.NamedEntityCreate, db: Session = Depends(get_db)):
    return crud.create_named_entity(db, models.Faculty, payload.name)


@app.get("/rooms", response_model=List[schemas.NamedEntity])
def list_rooms(db: Session = Depends(get_db)):
    return crud.list_named_entities(db, models.Room)


@app.post("/rooms", response_model=schemas.NamedEntity)
def create_room(payload: schemas.NamedEntityCreate, db: Session = Depends(get_db)):
    return crud.create_named_entity(db, models.Room, payload.name)


@app.get("/conflicts", response_model=schemas.ConflictReport)
def list_conflicts(
    ignore_faculty: bool = False,
    ignore_room: bool = False,
    ignore_tba: bool = False,
    ignore_faculty_list: str | None = None,
    ignore_room_list: str | None = None,
    contains_faculty: bool = False,
    contains_room: bool = False,
    db: Session = Depends(get_db),
):
    faculty_list = ignore_faculty_list.split(",") if ignore_faculty_list else []
    room_list = ignore_room_list.split(",") if ignore_room_list else []
    conflicts_list = conflicts.find_conflicts(
        db,
        ignore_faculty=ignore_faculty,
        ignore_room=ignore_room,
        ignore_tba=ignore_tba,
        ignore_faculty_list=faculty_list,
        ignore_room_list=room_list,
        contains_faculty=contains_faculty,
        contains_room=contains_room,
    )
    grouped = {}
    for conflict in conflicts_list:
        grouped.setdefault((conflict["entry_id"], conflict["conflict_type"]), []).append(
            conflict["conflicts_with"]
        )
    response = [
        schemas.ConflictSummary(
            entry_id=entry_id,
            conflicts_with=conflict_ids,
            conflict_type=conflict_type,
        )
        for (entry_id, conflict_type), conflict_ids in grouped.items()
    ]
    return schemas.ConflictReport(conflicts=response)


@app.get("/reports/text.csv")
def export_text_csv(db: Session = Depends(get_db)):
    entries = [
        schemas.ScheduleEntry.from_orm(entry).model_dump(by_alias=True)
        for entry in crud.list_schedule_entries(db)
    ]
    rows = reports.build_text_rows(entries)
    content = reports.write_csv(rows)
    return Response(content, media_type="text/csv")


def filter_entries(entries, group: str, filter_value: str | None):
    if group not in {"section", "faculty", "room"}:
        raise HTTPException(status_code=400, detail="Invalid group")
    if group == "section":
        if filter_value:
            entries = [e for e in entries if e["Section"] == filter_value]
    elif group == "faculty":
        if filter_value:
            entries = [e for e in entries if e["Faculty"] == filter_value]
    elif group == "room":
        if filter_value:
            entries = [e for e in entries if e["Room"] == filter_value]
    return entries


@app.get("/reports/timetable/{group}.csv")
def export_timetable_csv(group: str, filter_value: str | None = None, db: Session = Depends(get_db)):
    entries = [
        schemas.ScheduleEntry.from_orm(entry).model_dump(by_alias=True)
        for entry in crud.list_schedule_entries(db)
    ]
    entries = filter_entries(entries, group, filter_value)
    rows = reports.build_text_rows(entries)
    content = reports.write_csv(rows)
    return Response(content, media_type="text/csv")


@app.post("/file/import")
def import_database(file: UploadFile = File(...)):
    target = DATABASE_PATH
    temp_path = target.with_suffix(".upload")
    with temp_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    shutil.move(str(temp_path), target)
    return {"ok": True}


@app.post("/file/import-csv")
def import_csv(
    file: UploadFile = File(...),
    replace: bool = False,
    preview: bool = False,
    db: Session = Depends(get_db),
):
    text_stream = io.TextIOWrapper(file.file, encoding="utf-8-sig")
    reader = csv.reader(text_stream)
    header_row = next(reader, [])

    header_map = {}
    required_map = {
        "program": "Program",
        "section": "Section",
        "course code": "Course Code",
        "course description": "Course Description",
        "units": "Units",
        "# of hours": "# of Hours",
        "time (lpu std)": "Time (LPU Std)",
        "time (24 hrs)": "Time (24 Hrs)",
        "days": "Days",
        "room": "Room",
        "faculty": "Faculty",
    }
    for idx, header in enumerate(header_row):
        cleaned = header.strip()
        if not cleaned or cleaned.lower().startswith("unnamed"):
            continue
        key = required_map.get(cleaned.lower())
        if key:
            header_map[key] = idx

    required_headers = [
        "Program",
        "Section",
        "Course Code",
        "Course Description",
        "Units",
        "# of Hours",
        "Time (LPU Std)",
        "Days",
        "Room",
        "Faculty",
    ]
    missing = [header for header in required_headers if header not in header_map]
    rows_total = 0
    rows_imported = 0
    rows_skipped = 0
    errors = []

    if missing:
        return {
            "rows_total": 0,
            "rows_imported": 0,
            "rows_skipped": 0,
            "missing_columns": missing,
            "errors": [{"row_index": 0, "reason": "Missing required columns"}],
        }

    if replace and not preview:
        db.query(models.ScheduleEntry).delete()
        db.commit()

    sections = {section.name.lower(): section for section in db.scalars(select(models.Section))}
    faculty = {item.name.lower(): item for item in db.scalars(select(models.Faculty))}
    rooms = {item.name.lower(): item for item in db.scalars(select(models.Room))}

    def ensure_entity(name: str, collection: dict, model_cls):
        key = name.lower()
        instance = collection.get(key)
        if instance:
            return instance
        instance = model_cls(name=name)
        db.add(instance)
        collection[key] = instance
        return instance

    for idx, row in enumerate(reader, start=2):
        rows_total += 1
        try:
            def get_value(header: str) -> str:
                value = row[header_map[header]] if header_map.get(header) is not None and len(row) > header_map[header] else ""
                return value.strip()

            program = get_value("Program")
            section = get_value("Section")
            course_code = get_value("Course Code")
            course_description = get_value("Course Description")
            units = get_value("Units")
            hours = get_value("# of Hours")
            time_lpu = get_value("Time (LPU Std)")
            days = get_value("Days")
            room = get_value("Room")
            faculty_name = get_value("Faculty")

            if time_utils.is_tba(time_lpu) or time_utils.is_tba(days):
                normalized_lpu = "TBA"
                normalized_days = "TBA"
                time_24 = None
                start_minutes = None
                end_minutes = None
            else:
                normalized_lpu, time_24, start_minutes, end_minutes = time_utils.parse_time_lpu(
                    time_lpu
                )
                normalized_days = time_utils.normalize_days_string(days)
                if not normalized_days:
                    raise ValueError("Invalid Days. Example: M,W,F")

            if not preview:
                ensure_entity(section, sections, models.Section)
                ensure_entity(faculty_name, faculty, models.Faculty)
                ensure_entity(room, rooms, models.Room)

                entry = models.ScheduleEntry(
                    program=program,
                    section=section,
                    course_code=course_code,
                    course_description=course_description,
                    units=float(units) if units else 0,
                    hours=float(hours) if hours else 0,
                    time_lpu=normalized_lpu,
                    time_24=time_24,
                    days=normalized_days,
                    room=room,
                    faculty=faculty_name,
                    start_minutes=start_minutes,
                    end_minutes=end_minutes,
                )
                db.add(entry)
            rows_imported += 1
        except ValueError as exc:
            rows_skipped += 1
            errors.append({"row_index": idx, "reason": str(exc)})

    if not preview:
        db.commit()

    return {
        "rows_total": rows_total,
        "rows_imported": rows_imported,
        "rows_skipped": rows_skipped,
        "missing_columns": [],
        "errors": errors,
    }


@app.get("/file/export")
def export_database():
    if not DATABASE_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    return FileResponse(path=DATABASE_PATH, filename="scheduler.db")


@app.post("/file/reset")
def reset_database(db: Session = Depends(get_db)):
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    return {"ok": True}


@app.post("/export/png")
def export_png(payload: dict):
    category = payload.get("category")
    name = payload.get("name")
    png_base64 = payload.get("png_base64")
    batch_id = payload.get("batch_id") or uuid4().hex
    if category not in {"faculty", "section", "room"}:
        raise HTTPException(status_code=400, detail="Invalid category")
    if not name or not png_base64:
        raise HTTPException(status_code=400, detail="Missing export data")
    if "," in png_base64:
        png_base64 = png_base64.split(",", 1)[1]
    try:
        data = base64.b64decode(png_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid PNG payload") from exc

    folder_map = {
        "faculty": "Timetables_Faculty",
        "section": "Timetables_Section",
        "room": "Timetables_Room",
    }
    base_dir = Path.cwd() / "exports" / batch_id / folder_map[category]
    base_dir.mkdir(parents=True, exist_ok=True)
    file_path = base_dir / f"{name}.png"
    file_path.write_bytes(data)
    return {"ok": True, "path": str(file_path)}
