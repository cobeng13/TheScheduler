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


def test_reports_and_conflicts_endpoints():
    assert client.get("/conflicts").status_code == 200
    assert client.get("/reports/text.csv").status_code == 200
    assert client.get("/reports/timetable/section.xlsx").status_code == 200
