from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import conflicts, models, time_utils


def setup_db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    models.Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def test_overlap_logic():
    assert time_utils.overlap(60, 120, 110, 180) is True
    assert time_utils.overlap(60, 120, 120, 180) is False
    assert time_utils.overlap(60, 120, 0, 59) is False


def test_conflict_detection_room_and_faculty():
    db = setup_db()
    entry_a = models.ScheduleEntry(
        program="BSCS",
        section="A",
        course_code="CS101",
        course_description="Intro",
        units=3,
        hours=3,
        time_lpu="7:00 AM - 8:00 AM",
        time_24="07:00-08:00",
        days="Monday",
        room="R101",
        faculty="Dr. Ada",
        start_minutes=420,
        end_minutes=480,
    )
    entry_b = models.ScheduleEntry(
        program="BSCS",
        section="B",
        course_code="CS102",
        course_description="Data",
        units=3,
        hours=3,
        time_lpu="7:30 AM - 8:30 AM",
        time_24="07:30-08:30",
        days="Monday",
        room="R101",
        faculty="Dr. Ada",
        start_minutes=450,
        end_minutes=510,
    )
    db.add_all([entry_a, entry_b])
    db.commit()

    conflicts_found = conflicts.find_conflicts(db)
    conflict_types = {(c["entry_id"], c["conflict_type"]) for c in conflicts_found}
    assert (entry_a.id, "room") in conflict_types
    assert (entry_a.id, "faculty") in conflict_types
