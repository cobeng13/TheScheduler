from __future__ import annotations

import csv
import io
from typing import Iterable

from openpyxl import Workbook
from openpyxl.styles import Font

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
