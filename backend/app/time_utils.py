from __future__ import annotations

import re

TIME_RANGE_RE = re.compile(r"^(\d{2}):(\d{2})-(\d{2}):(\d{2})$")


def parse_time_range(time_24: str) -> tuple[int, int]:
    match = TIME_RANGE_RE.match(time_24.strip())
    if not match:
        raise ValueError("Time (24 Hrs) must be in HH:MM-HH:MM format")
    start_h, start_m, end_h, end_m = (int(val) for val in match.groups())
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m
    if start_minutes >= end_minutes:
        raise ValueError("Start time must be before end time")
    return start_minutes, end_minutes


def normalize_days(days: str) -> set[str]:
    cleaned = [day.strip().capitalize() for day in days.split(",") if day.strip()]
    return set(cleaned)


def overlap(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return start_a < end_b and start_b < end_a
