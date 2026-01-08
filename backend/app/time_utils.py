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


DAY_ALIASES = {
    "m": "M",
    "mon": "M",
    "monday": "M",
    "t": "T",
    "tu": "T",
    "tue": "T",
    "tues": "T",
    "tuesday": "T",
    "w": "W",
    "wed": "W",
    "weds": "W",
    "wednesday": "W",
    "th": "Th",
    "thu": "Th",
    "thur": "Th",
    "thurs": "Th",
    "thursday": "Th",
    "f": "F",
    "fri": "F",
    "friday": "F",
    "sa": "Sa",
    "sat": "Sa",
    "saturday": "Sa",
    "su": "Su",
    "sun": "Su",
    "sunday": "Su",
}

CANONICAL_DAYS = {"M", "T", "W", "Th", "F", "Sa", "Su"}


def _parse_compact_days(value: str) -> list[str]:
    tokens = []
    idx = 0
    while idx < len(value):
        if value[idx : idx + 2].lower() == "th":
            tokens.append("Th")
            idx += 2
        elif value[idx : idx + 2].lower() == "sa":
            tokens.append("Sa")
            idx += 2
        elif value[idx : idx + 2].lower() == "su":
            tokens.append("Su")
            idx += 2
        else:
            char = value[idx].lower()
            tokens.append(DAY_ALIASES.get(char, value[idx]))
            idx += 1
    return tokens


def normalize_days_string(days: str) -> str:
    if not days:
        return ""
    raw = days.replace("/", ",").replace(" ", ",")
    parts = [part for part in raw.split(",") if part]
    if len(parts) == 1 and len(parts[0]) > 2 and parts[0].isalpha():
        tokens = _parse_compact_days(parts[0])
    else:
        tokens = []
        for part in parts:
            key = part.strip().lower()
            if not key:
                continue
            tokens.append(DAY_ALIASES.get(key, part.strip()))
    normalized = [token for token in tokens if token in CANONICAL_DAYS]
    return ",".join(normalized)


def normalize_days(days: str) -> set[str]:
    normalized = normalize_days_string(days)
    return {token for token in normalized.split(",") if token}


def overlap(start_a: int, end_a: int, start_b: int, end_b: int) -> bool:
    return start_a < end_b and start_b < end_a
