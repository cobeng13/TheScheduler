from __future__ import annotations

import csv
import html
import io
import re
from typing import Iterable

from . import time_utils

from .schemas import CANONICAL_HEADERS


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


def _faculty_entry_hours(entry: dict) -> float:
    try:
        time_24 = entry.get("Time (24 Hrs)") or ""
        if time_24.strip():
            start, end = time_utils.parse_time_range(time_24)
        else:
            _lpu, _time_24, start, end = time_utils.parse_time_lpu(
                entry.get("Time (LPU Std)") or ""
            )
    except ValueError:
        return 0.0
    return round((end - start) / 60 * len(time_utils.normalize_days(entry.get("Days") or "")), 2)


def _faculty_entry_type(entry: dict) -> str:
    label = f'{entry.get("Course Code", "")} {entry.get("Course Description", "")}'
    return "LAB" if re.search(r"\blab(?:oratory)?\b", label, re.IGNORECASE) else "LEC"


def _format_hours(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:.2f}".rstrip("0")


def _entry_units(entry: dict) -> float:
    try:
        return round(float(entry.get("Units") or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def build_faculty_load_html(faculty: str, entries: Iterable[dict]) -> bytes:
    load_rows = []
    for entry in entries:
        hours = _faculty_entry_hours(entry)
        load_rows.append((entry, hours, _entry_units(entry), _faculty_entry_type(entry)))
    load_rows.sort(
        key=lambda item: (
            str(item[0].get("Course Code", "")).lower(),
            str(item[0].get("Section", "")).lower(),
            str(item[0].get("Days", "")).lower(),
            str(item[0].get("Time (24 Hrs)", "")).lower(),
        )
    )
    lecture_hours = round(
        sum(hours for _entry, hours, _units, kind in load_rows if kind == "LEC"), 2
    )
    laboratory_hours = round(
        sum(hours for _entry, hours, _units, kind in load_rows if kind == "LAB"), 2
    )
    lecture_units = round(
        sum(units for _entry, _hours, units, kind in load_rows if kind == "LEC"), 2
    )
    laboratory_units = round(
        sum(units for _entry, _hours, units, kind in load_rows if kind == "LAB"), 2
    )
    total_hours = round(lecture_hours + laboratory_hours, 2)
    total_units = round(lecture_units + laboratory_units, 2)

    body_rows = "".join(
        "<tr>"
        f'<td>{html.escape(str(entry.get("Course Code", "")))}</td>'
        f'<td>{html.escape(str(entry.get("Section", "")))}</td>'
        f'<td>{html.escape(str(entry.get("Days", "")))} '
        f'{html.escape(str(entry.get("Time (LPU Std)", "")))}</td>'
        f'<td>{html.escape(str(entry.get("Room", "")))}</td>'
        f'<td class="number">{_format_hours(hours)}</td>'
        f'<td class="number">{_format_hours(units)}</td>'
        f'<td>{kind}</td>'
        "</tr>"
        for entry, hours, units, kind in load_rows
    )
    if not body_rows:
        body_rows = '<tr><td colspan="7" class="empty">No scheduled classes.</td></tr>'

    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Faculty Load - {html.escape(faculty)}</title>
  <style>
    @page {{ size: A4; margin: 18mm; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; color: #111; font-family: Arial, sans-serif; font-size: 11pt; }}
    h1 {{ margin: 0 0 20px; text-align: center; font-size: 18pt; }}
    .summary {{ margin-bottom: 20px; line-height: 1.6; }}
    .faculty {{ font-size: 13pt; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ border: 1px solid #333; padding: 7px 8px; text-align: left; vertical-align: top; }}
    th {{ background: #e9eef5; font-weight: 700; }}
    .number {{ text-align: right; }}
    .empty {{ padding: 22px; text-align: center; color: #555; }}
    @media print {{ h1, .summary, thead {{ break-after: avoid; }} tr {{ break-inside: avoid; }} }}
  </style>
</head>
<body>
  <h1>Faculty Load</h1>
  <div class="summary">
    <div class="faculty"><strong>Faculty Name:</strong> {html.escape(faculty)}</div>
    <div><strong>Total Number of Hours:</strong> {_format_hours(total_hours)}</div>
    <div><strong>Total Number of Units:</strong> {_format_hours(total_units)}</div>
    <div><strong>Hours Lecture:</strong> {_format_hours(lecture_hours)}</div>
    <div><strong>Units Lecture:</strong> {_format_hours(lecture_units)}</div>
    <div><strong>Hours Laboratory:</strong> {_format_hours(laboratory_hours)}</div>
    <div><strong>Units Laboratory:</strong> {_format_hours(laboratory_units)}</div>
  </div>
  <table>
    <thead><tr><th>Course Code</th><th>Section</th><th>Time</th><th>Room</th><th>Number of Hours</th><th># of Units</th><th>LEC/LAB</th></tr></thead>
    <tbody>{body_rows}</tbody>
  </table>
</body>
</html>"""
    return document.encode("utf-8")
