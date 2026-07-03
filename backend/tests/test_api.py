from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_schedule_list_endpoint():
    response = client.get("/schedule")
    assert response.status_code == 200


def test_create_and_delete_schedule_entry():
    payload = {
        "Program": "BSCS",
        "Section": "A",
        "Course Code": "CS201",
        "Course Description": "Algorithms",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "1:00p-2:30p",
        "Time (24 Hrs)": "13:00-14:30",
        "Days": "Monday",
        "Room": "R101",
        "Faculty": "Dr. Ada",
    }
    create_response = client.post("/schedule", json=payload)
    assert create_response.status_code == 200
    entry_id = create_response.json()["id"]

    delete_response = client.delete(f"/schedule/{entry_id}")
    assert delete_response.status_code == 200


def test_same_section_overlap_is_rejected_on_create_and_move_check():
    suffix = uuid4().hex[:8]
    section = f"BUG-SECTION-{suffix}"
    first_payload = {
        "Program": "BSPharm",
        "Section": section,
        "Course Code": f"A-{suffix}",
        "Course Description": "Course A",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "7:00a-10:00a",
        "Time (24 Hrs)": "07:00-10:00",
        "Days": "M",
        "Room": f"Room A {suffix}",
        "Faculty": f"Faculty A {suffix}",
    }
    second_payload = {
        **first_payload,
        "Course Code": f"B-{suffix}",
        "Course Description": "Course B",
        "Room": f"Room B {suffix}",
        "Faculty": f"Faculty B {suffix}",
    }
    create_response = client.post("/schedule", json=first_payload)
    assert create_response.status_code == 200
    entry_id = create_response.json()["id"]

    move_check_response = client.post("/schedule/0/move-check", json=second_payload)
    assert move_check_response.status_code == 200
    move_check_body = move_check_response.json()
    assert move_check_body["ok"] is False
    assert move_check_body["conflicts"][0]["conflict_type"] == "section"

    blocked_create_response = client.post("/schedule", json=second_payload)
    assert blocked_create_response.status_code == 422
    assert blocked_create_response.json()["detail"] == "Section has another class at the same time"

    assert client.delete(f"/schedule/{entry_id}").status_code == 200


def test_reports_and_conflicts_endpoints():
    assert client.get("/conflicts").status_code == 200
    assert client.get("/reports/text.csv").status_code == 200
    assert client.get("/reports/timetable/section.csv").status_code == 200


def test_update_and_delete_section():
    suffix = uuid4().hex[:8]
    create_response = client.post("/sections", json={"name": f"TEMP-A-{suffix}"})
    assert create_response.status_code == 200
    section_id = create_response.json()["id"]

    update_response = client.put(f"/sections/{section_id}", json={"name": f"TEMP-B-{suffix}"})
    assert update_response.status_code == 200
    assert update_response.json()["name"] == f"TEMP-B-{suffix}"

    delete_response = client.delete(f"/sections/{section_id}")
    assert delete_response.status_code == 200


def test_section_rename_updates_entries_and_delete_is_blocked_when_used():
    suffix = uuid4().hex[:8]
    section_name = f"TEMP-C-{suffix}"
    renamed_section = f"TEMP-D-{suffix}"
    create_section_response = client.post("/sections", json={"name": section_name})
    assert create_section_response.status_code == 200
    section_id = create_section_response.json()["id"]
    payload = {
        "Program": "BSCS",
        "Section": section_name,
        "Course Code": f"CS-{suffix}",
        "Course Description": "Temporary Course",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "TBA",
        "Time (24 Hrs)": "",
        "Days": "TBA",
        "Room": "TBA",
        "Faculty": "TBA",
    }
    create_entry_response = client.post("/schedule", json=payload)
    assert create_entry_response.status_code == 200
    entry_id = create_entry_response.json()["id"]

    update_response = client.put(f"/sections/{section_id}", json={"name": renamed_section})
    assert update_response.status_code == 200
    assert client.get(f"/schedule/{entry_id}").json()["Section"] == renamed_section

    blocked_delete_response = client.delete(f"/sections/{section_id}")
    assert blocked_delete_response.status_code == 409

    assert client.delete(f"/schedule/{entry_id}").status_code == 200
    assert client.delete(f"/sections/{section_id}").status_code == 200
