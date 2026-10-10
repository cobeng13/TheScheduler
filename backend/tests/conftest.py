import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
_TEST_DIRECTORY = tempfile.TemporaryDirectory(prefix="scheduler-tests-")
TEST_DATABASE_PATH = Path(_TEST_DIRECTORY.name) / "scheduler-test.db"
os.environ["SCHEDULER_DB_PATH"] = str(TEST_DATABASE_PATH)


def pytest_sessionfinish(session, exitstatus):
    from app.db import engine
    engine.dispose()
    _TEST_DIRECTORY.cleanup()
