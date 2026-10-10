import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
TEST_DATABASE_PATH = ROOT / "tests" / "scheduler-test.db"
if TEST_DATABASE_PATH.exists():
    TEST_DATABASE_PATH.unlink()
os.environ["SCHEDULER_DB_PATH"] = str(TEST_DATABASE_PATH)
