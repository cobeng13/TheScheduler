from __future__ import annotations

import shutil
from typing import List

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from . import conflicts, crud, models, reports, schemas
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
