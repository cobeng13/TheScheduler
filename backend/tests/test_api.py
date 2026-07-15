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
    response = client.get("/reports/faculty-load.html", params={"faculty": "Dr. Ada"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "Faculty Load" in response.text


def test_faculty_load_report_totals_lecture_and_lab():
    from app import reports

    entries = [
        {
            "Course Code": "PHAR101 LEC",
            "Course Description": "Pharmacy Lecture",
            "Section": "A",
            "Room": "Room 101",
            "Units": 3,
            "Time (LPU Std)": "8:00a-9:30a",
            "Time (24 Hrs)": "08:00-09:30",
            "Days": "M,W",
        },
        {
            "Course Code": "PHAR101 LAB",
            "Course Description": "Pharmacy Laboratory",
            "Section": "A",
            "Room": "Laboratory 2",
            "Units": 1,
            "Time (LPU Std)": "1:00p-4:00p",
            "Time (24 Hrs)": "13:00-16:00",
            "Days": "F",
        },
    ]
    report = reports.build_faculty_load_html("Dr. Test", entries).decode("utf-8")
    assert "Total Number of Hours:</strong> 6" in report
    assert "Hours Lecture:</strong> 3" in report
    assert "Units Lecture:</strong> 3" in report
    assert "Hours Laboratory:</strong> 3" in report
    assert "Units Laboratory:</strong> 1" in report
    assert "Total Number of Units:</strong> 4" in report
    assert "PHAR101 LAB" in report
    assert "<th>Number of Hours</th><th># of Units</th><th>LEC/LAB</th>" in report
    assert "Laboratory 2" in report


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


def test_force_delete_section_removes_related_entries():
    suffix = uuid4().hex[:8]
    section_name = f"FORCE-SECTION-{suffix}"
    create_section_response = client.post("/sections", json={"name": section_name})
    assert create_section_response.status_code == 200
    section_id = create_section_response.json()["id"]
    payload = {
        "Program": "BSCS",
        "Section": section_name,
        "Course Code": f"CS-FORCE-{suffix}",
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

    forced_delete_response = client.delete(f"/sections/{section_id}?force=true")
    assert forced_delete_response.status_code == 200
    assert client.get(f"/schedule/{entry_id}").status_code == 404


def test_faculty_and_room_renames_update_entries_and_force_delete_removes_entries():
    suffix = uuid4().hex[:8]
    faculty_name = f"FAC-A-{suffix}"
    renamed_faculty = f"FAC-B-{suffix}"
    room_name = f"ROOM-A-{suffix}"
    renamed_room = f"ROOM-B-{suffix}"

    faculty_response = client.post("/faculty", json={"name": faculty_name})
    room_response = client.post("/rooms", json={"name": room_name})
    assert faculty_response.status_code == 200
    assert room_response.status_code == 200
    faculty_id = faculty_response.json()["id"]
    room_id = room_response.json()["id"]

    payload = {
        "Program": "BSCS",
        "Section": f"SEC-{suffix}",
        "Course Code": f"CS-{suffix}",
        "Course Description": "Temporary Course",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "TBA",
        "Time (24 Hrs)": "",
        "Days": "TBA",
        "Room": room_name,
        "Faculty": faculty_name,
    }
    create_entry_response = client.post("/schedule", json=payload)
    assert create_entry_response.status_code == 200
    entry_id = create_entry_response.json()["id"]

    faculty_update = client.put(f"/faculty/{faculty_id}", json={"name": renamed_faculty})
    room_update = client.put(f"/rooms/{room_id}", json={"name": renamed_room})
    assert faculty_update.status_code == 200
    assert room_update.status_code == 200
    renamed_entry = client.get(f"/schedule/{entry_id}").json()
    assert renamed_entry["Faculty"] == renamed_faculty
    assert renamed_entry["Room"] == renamed_room

    blocked_delete_response = client.delete(f"/faculty/{faculty_id}")
    assert blocked_delete_response.status_code == 409

    forced_delete_response = client.delete(f"/faculty/{faculty_id}?force=true")
    assert forced_delete_response.status_code == 200
    assert client.get(f"/schedule/{entry_id}").status_code == 404
    assert client.delete(f"/rooms/{room_id}").status_code == 200


def test_post_remove_faculty_and_room_force_removes_related_entries():
    suffix = uuid4().hex[:8]
    faculty_name = f"POST-FAC-{suffix}"
    room_name = f"POST-ROOM-{suffix}"
    faculty_id = client.post("/faculty", json={"name": faculty_name}).json()["id"]
    room_id = client.post("/rooms", json={"name": room_name}).json()["id"]
    payload = {
        "Program": "BSCS",
        "Section": f"POST-SEC-{suffix}",
        "Course Code": f"POST-CS-{suffix}",
        "Course Description": "Temporary Course",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "TBA",
        "Time (24 Hrs)": "",
        "Days": "TBA",
        "Room": room_name,
        "Faculty": faculty_name,
    }
    entry_id = client.post("/schedule", json=payload).json()["id"]

    blocked_response = client.post(f"/faculty/{faculty_id}/remove")
    assert blocked_response.status_code == 409
    force_response = client.post(f"/faculty/{faculty_id}/remove?force=true")
    assert force_response.status_code == 200
    assert client.get(f"/schedule/{entry_id}").status_code == 404
    assert client.post(f"/rooms/{room_id}/remove").status_code == 200


def test_legacy_delete_faculty_succeeds_after_related_entries_are_removed():
    suffix = uuid4().hex[:8]
    faculty_name = f"LEGACY-FAC-{suffix}"
    faculty_id = client.post("/faculty", json={"name": faculty_name}).json()["id"]
    payload = {
        "Program": "BSCS",
        "Section": f"LEGACY-SEC-{suffix}",
        "Course Code": f"LEGACY-CS-{suffix}",
        "Course Description": "Temporary Course",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "TBA",
        "Time (24 Hrs)": "",
        "Days": "TBA",
        "Room": "TBA",
        "Faculty": faculty_name,
    }
    entry_id = client.post("/schedule", json=payload).json()["id"]

    assert client.delete(f"/schedule/{entry_id}").status_code == 200
    assert client.delete(f"/faculty/{faculty_id}").status_code == 200


def test_merge_faculty_updates_entries_when_no_conflict():
    suffix = uuid4().hex[:8]
    source_name = f"MERGE-FAC-A-{suffix}"
    target_name = f"MERGE-FAC-B-{suffix}"
    source_id = client.post("/faculty", json={"name": source_name}).json()["id"]
    target_response = client.post("/faculty", json={"name": target_name})
    assert target_response.status_code == 200

    payload = {
        "Program": "BSCS",
        "Section": f"SEC-A-{suffix}",
        "Course Code": f"CS-A-{suffix}",
        "Course Description": "Temporary Course",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "7:00a-8:00a",
        "Time (24 Hrs)": "07:00-08:00",
        "Days": "M",
        "Room": f"ROOM-A-{suffix}",
        "Faculty": source_name,
    }
    entry_id = client.post("/schedule", json=payload).json()["id"]

    merge_response = client.put(f"/faculty/{source_id}?merge=true", json={"name": target_name})
    assert merge_response.status_code == 200
    assert client.get(f"/schedule/{entry_id}").json()["Faculty"] == target_name
    assert all(item["name"] != source_name for item in client.get("/faculty").json())

    assert client.delete(f"/schedule/{entry_id}").status_code == 200


def test_merge_faculty_and_room_are_blocked_when_conflicts_would_result():
    suffix = uuid4().hex[:8]
    source_faculty = f"BLOCK-FAC-A-{suffix}"
    target_faculty = f"BLOCK-FAC-B-{suffix}"
    source_room = f"BLOCK-ROOM-A-{suffix}"
    target_room = f"BLOCK-ROOM-B-{suffix}"
    faculty_id = client.post("/faculty", json={"name": source_faculty}).json()["id"]
    room_id = client.post("/rooms", json={"name": source_room}).json()["id"]
    assert client.post("/faculty", json={"name": target_faculty}).status_code == 200
    assert client.post("/rooms", json={"name": target_room}).status_code == 200

    first_payload = {
        "Program": "BSCS",
        "Section": f"SEC-A-{suffix}",
        "Course Code": f"CS-A-{suffix}",
        "Course Description": "Temporary Course A",
        "Units": 3,
        "# of Hours": 3,
        "Time (LPU Std)": "8:00a-9:00a",
        "Time (24 Hrs)": "08:00-09:00",
        "Days": "M",
        "Room": source_room,
        "Faculty": source_faculty,
    }
    second_payload = {
        **first_payload,
        "Section": f"SEC-B-{suffix}",
        "Course Code": f"CS-B-{suffix}",
        "Course Description": "Temporary Course B",
        "Room": target_room,
        "Faculty": target_faculty,
    }
    first_id = client.post("/schedule", json=first_payload).json()["id"]
    second_id = client.post("/schedule", json=second_payload).json()["id"]

    faculty_merge = client.put(f"/faculty/{faculty_id}?merge=true", json={"name": target_faculty})
    room_merge = client.put(f"/rooms/{room_id}?merge=true", json={"name": target_room})
    assert faculty_merge.status_code == 409
    assert room_merge.status_code == 409
    assert client.get(f"/schedule/{first_id}").json()["Faculty"] == source_faculty
    assert client.get(f"/schedule/{first_id}").json()["Room"] == source_room

    assert client.delete(f"/schedule/{first_id}").status_code == 200
    assert client.delete(f"/schedule/{second_id}").status_code == 200
