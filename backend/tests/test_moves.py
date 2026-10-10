import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models, moves, schemas
from app.main import app, get_db


@pytest.fixture
def move_client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    models.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    def session_override():
        with factory() as db:
            yield db
    app.dependency_overrides[get_db] = session_override
    with factory() as db:
        db.add_all([models.Section(name="A"), models.Section(name="B"),
                    models.Faculty(name="Ada"), models.Faculty(name="Grace"),
                    models.Room(name="R1"), models.Room(name="R2")])
        db.commit()
    with TestClient(app) as client:
        yield client, factory
    app.dependency_overrides.clear()
    engine.dispose()


def create(client, **changes):
    payload = {"Program": "BSCS", "Section": "A", "Course Code": "CS101",
               "Course Description": "Intro", "Units": 3, "# of Hours": 2,
               "Time (LPU Std)": "7:00a-8:00a", "Time (24 Hrs)": "07:00-08:00",
               "Days": "M,W", "Room": "R1", "Faculty": "Ada", **changes}
    response = client.post("/schedule", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def move(client, entry, **changes):
    return client.post(f'/schedule/{entry["id"]}/move', json={
        "source_day": "M", "destination_day": "T", "start_minutes": 600,
        "expected": entry, **changes,
    })


@pytest.mark.parametrize("kind,field,name", [("section", "Section", "B"), ("faculty", "Faculty", "Grace"), ("room", "Room", "R2")])
def test_move_reassigns_only_one_meeting_and_undo_restores_everything(move_client, kind, field, name):
    client, _ = move_client
    entry = create(client)
    response = move(client, entry, assignment={"kind": kind, "name": name})
    assert response.status_code == 200, response.text
    result = response.json()
    entries = client.get("/schedule").json()
    assert len(entries) == 2
    original = next(row for row in entries if row["id"] == entry["id"])
    moved = next(row for row in entries if row["id"] == result["moved_entry_id"])
    assert original["Days"] == "W" and original[field] == entry[field]
    assert original["Time (24 Hrs)"] == "07:00-08:00"
    assert moved["Days"] == "T" and moved[field] == name
    assert moved["Time (24 Hrs)"] == "10:00-11:00"
    assert moved["Program"] == entry["Program"]
    for other in {"Section", "Faculty", "Room"} - {field}:
        assert moved[other] == entry[other]
    assert moved["# of Hours"] == (1 if kind == "section" else 2)
    reverted = client.post(f'/schedule/{entry["id"]}/move/revert', json=result["snapshot"])
    assert reverted.status_code == 200, reverted.text
    assert client.get("/schedule").json() == [entry]


def test_single_day_move_noop_bounds_and_missing_assignment(move_client):
    client, _ = move_client
    entry = create(client, Days="M", **{"# of Hours": 1})
    noop = move(client, entry, destination_day="M", start_minutes=420)
    assert noop.status_code == 200 and noop.json()["snapshot"] is None
    for changes in [{"start_minutes": 1250}, {"destination_day": "bad"},
                    {"assignment": {"kind": "room", "name": "missing"}}, {"source_day": "F"},
                    {"curriculum_hours": {"a": -1}}, {"curriculum_hours": {"a": "NaN"}},
                    {"conflict_settings": {"ignore_room_list": "R1"}}]:
        assert move(client, entry, **changes).status_code == 422
        assert client.get("/schedule").json() == [entry]
    result = move(client, entry, destination_day="Sa").json()
    assert result["moved_entry_id"] == entry["id"]
    assert len(client.get("/schedule").json()) == 1


@pytest.mark.parametrize("field,kind,name", [("Section", "section", "B"), ("Faculty", "faculty", "Grace"), ("Room", "room", "R2")])
def test_conflict_rolls_back_split(move_client, field, kind, name):
    client, _ = move_client
    entry = create(client)
    create(client, Section="B", Faculty="Grace", Room="R2", Days="T", **{"Course Code": "OTHER", "Time (LPU Std)": "10:00a-11:00a"})
    before = client.get("/schedule").json()
    response = move(client, entry, assignment={"kind": kind, "name": name})
    assert response.status_code == 409, response.text
    assert any(item["conflict_type"] == kind for item in response.json()["detail"]["conflicts"])
    assert client.get("/schedule").json() == before


def test_rules_curriculum_hours_and_stale_source(move_client):
    client, _ = move_client
    entry = create(client)
    create(client, Section="B", Faculty="Ada", Room="R1", Days="T", **{"Course Code": "OTHER", "Time (LPU Std)": "10:00a-11:00a"})
    response = move(client, entry, conflict_settings={"ignore_faculty": True, "ignore_room": True}, curriculum_hours={"a": 4})
    assert response.status_code == 200, response.text
    assert all(row["# of Hours"] == 4 for row in response.json()["entries"])
    assert move(client, entry).status_code == 409


def test_stale_and_tampered_undo_leave_data_intact(move_client):
    client, _ = move_client
    entry = create(client)
    snapshot = move(client, entry).json()["snapshot"]
    tampered = {**snapshot, "before": [{**snapshot["before"][0], "Faculty": "Grace"}]}
    before = client.get("/schedule").json()
    assert client.post(f'/schedule/{entry["id"]}/move/revert', json=tampered).status_code == 409
    assert client.get("/schedule").json() == before
    changed = before[0]
    assert client.put(f'/schedule/{changed["id"]}', json={**changed, "Course Description": "Changed"}).status_code == 200
    before = client.get("/schedule").json()
    assert client.post(f'/schedule/{entry["id"]}/move/revert', json=snapshot).status_code == 409
    assert client.get("/schedule").json() == before


def test_injected_failure_rolls_back_all_changes(move_client, monkeypatch):
    client, factory = move_client
    entry = create(client)
    def fail(*args):
        raise RuntimeError("simulated failure after split")
    monkeypatch.setattr(moves, "check_conflicts", fail)
    with factory() as db:
        request = schemas.MeetingMove(source_day="M", destination_day="T", start_minutes=600, expected=entry)
        with pytest.raises(RuntimeError):
            moves.move(db, entry["id"], request)
    assert client.get("/schedule").json() == [entry]


def test_undo_rechecks_new_conflicts_and_is_atomic(move_client):
    client, _ = move_client
    entry = create(client, Days="M", **{"# of Hours": 1})
    snapshot = move(client, entry).json()["snapshot"]
    create(client, Days="M", **{"Course Code": "OTHER", "Faculty": "Grace", "Room": "R2"})
    before = client.get("/schedule").json()
    response = client.post(f'/schedule/{entry["id"]}/move/revert', json=snapshot)
    assert response.status_code == 409
    assert client.get("/schedule").json() == before


def test_undo_can_restore_conflicts_that_already_existed_before_the_move(move_client):
    client, _ = move_client
    entry = create(client, Days="M", **{"# of Hours": 1})
    create(client, Section="B", Days="M", **{"Course Code": "OTHER"})
    before = client.get("/schedule").json()
    snapshot = move(client, entry).json()["snapshot"]
    response = client.post(f'/schedule/{entry["id"]}/move/revert', json=snapshot)
    assert response.status_code == 200, response.text
    assert client.get("/schedule").json() == before
