from __future__ import annotations

import re

TIME_RANGE_RE = re.compile(r"^(\d{2}):(\d{2})-(\d{2}):(\d{2})$")
LPU_TIME_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*([ap])\s*-\s*(\d{1,2}):(\d{2})\s*([ap])\s*$", re.IGNORECASE)


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


def format_time_24(minutes: int) -> str:
    hours = minutes // 60
    mins = minutes % 60
    return f"{hours:02d}:{mins:02d}"


def _to_minutes(hour: int, minute: int, meridian: str) -> int:
    if hour < 1 or hour > 12 or minute < 0 or minute > 59:
        raise ValueError("Invalid time component")
    meridian = meridian.lower()
    if meridian == "a":
        hour = 0 if hour == 12 else hour
    else:
        hour = 12 if hour == 12 else hour + 12
    return hour * 60 + minute


def parse_time_lpu(time_lpu: str) -> tuple[str, int, int]:
    match = LPU_TIME_RE.match(time_lpu)
    if not match:
        raise ValueError("Invalid Time (LPU Std). Example: 10:00a-12:00p")
    start_h, start_m, start_ampm, end_h, end_m, end_ampm = match.groups()
    start_minutes = _to_minutes(int(start_h), int(start_m), start_ampm)
    end_minutes = _to_minutes(int(end_h), int(end_m), end_ampm)
    if start_minutes >= end_minutes:
        raise ValueError("Invalid Time (LPU Std). Example: 10:00a-12:00p")
    return f"{format_time_24(start_minutes)}-{format_time_24(end_minutes)}", start_minutes, end_minutes


def normalize_days(days: str) -> set[str]:
    cleaned = [day.strip().capitalize() for day in days.split(",") if day.strip()]
    return set(cleaned)


def overlap(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return start_a < end_b and start_b < end_a
