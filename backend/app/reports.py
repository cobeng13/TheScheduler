from __future__ import annotations

import csv
import io
from typing import Iterable

from openpyxl import Workbook
from openpyxl.styles import Font

from .schemas import CANONICAL_HEADERS

TIMETABLE_DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
]


def build_text_rows(entries: Iterable[dict]) -> list[list[str]]:
    rows = [CANONICAL_HEADERS]
    for entry in entries:
        rows.append([
            entry["Program"],
            entry["Section"],
            entry["Course Code"],
            entry["Course Description"],
            str(entry["Units"]),
            str(entry["# of Hours"]),
            entry["Time (LPU Std)"],
            entry["Time (24 Hrs)"],
            entry["Days"],
            entry["Room"],
            entry["Faculty"],
        ])
    return rows


def write_csv(rows: list[list[str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def write_xlsx(rows: list[list[str]], title: str = "Report") -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = title
    for row in rows:
        ws.append(row)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    output = io.BytesIO()
    wb.save(output)
    return output.getvalue()


def build_timetable_grid(entries: Iterable[dict], start_hour: int = 7, end_hour: int = 21, interval: int = 30):
    slots: list[str] = []
    for minutes in range(start_hour * 60, end_hour * 60, interval):
        hours = minutes // 60
        mins = minutes % 60
        slots.append(f"{hours:02d}:{mins:02d}")

    grid = {day: {slot: "" for slot in slots} for day in TIMETABLE_DAYS}

    for entry in entries:
        try:
            start, end = entry["Time (24 Hrs)"].split("-")
        except ValueError:
            continue
        days = [day.strip() for day in entry["Days"].split(",") if day.strip()]
        description = f"{entry['Course Code']} | {entry['Section']} | {entry['Room']} | {entry['Faculty']}"
        for day in days:
            if day not in TIMETABLE_DAYS:
                continue
            for slot in slots:
                if start <= slot < end:
                    grid[day][slot] = description

    rows = [["Time", *TIMETABLE_DAYS]]
    for slot in slots:
        row = [slot]
        for day in TIMETABLE_DAYS:
            row.append(grid[day][slot])
        rows.append(row)
    return rows
