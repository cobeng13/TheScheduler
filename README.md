# Local Scheduler

Offline-first academic scheduling app running locally on `localhost` with a FastAPI backend and React + Vite frontend.

## Repository Structure

- `backend/` - FastAPI + SQLAlchemy + Alembic + SQLite + pytest
- `frontend/` - React + Vite + TypeScript UI

## Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Then open <http://localhost:5173>.

## Notes

- The SQLite database is stored at `backend/scheduler.db`.
- Use the ribbon **File** group for New/Save/Open timetable actions.
- CSV exports and timetable PNG export are available in the **Export** group.
- Conflicts highlight in red in both the grid and text view.
