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
- **Split View** shows independently selectable section, faculty, or room schedules. The divider can be dragged or resized with arrow keys; double-click or Home resets it. A blue border marks the active pane.
- Split View uses a popup class editor. Dragging across panes changes only the dragged meeting's section, faculty, or room to the destination selection; the preview shows the assignment and time. Conflicts block the move, and Undo restores the complete move.
- Vertical scrolling is linked by time by default, even at different zoom levels. Horizontal scrolling remains independent. Below 900px, switch between the saved left and right panes using the pane buttons.
- Current timetable PNG export uses the active pane; mass export keeps both displayed selections intact. Pane settings are remembered on this browser. Text View temporarily suspends Split View.
- Ctrl/Cmd+C copies a focused class block, Ctrl/Cmd+V pastes into the active section view, and Ctrl/Cmd+Z undoes the latest action. These shortcuts leave text fields and popup drafts alone.
- Meeting moves and reverts commit atomically. Undo snapshots are signed by the running backend and expire when that backend restarts; stale snapshots cannot overwrite later changes.

## Verification

Run `python -m pytest tests -q` from `backend/`. Tests use a temporary database.

From `frontend/`, run `npm run build`, `npx playwright install chromium`, then `npm test`. Browser tests use isolated synthetic schedule data and do not modify the working database. To use an installed Chrome instead, set `SCHEDULER_TEST_BROWSER=chrome` before running the tests.
