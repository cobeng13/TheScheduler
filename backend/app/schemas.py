from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


CANONICAL_HEADERS = [
    "Program",
    "Section",
    "Course Code",
    "Course Description",
    "Units",
    "# of Hours",
    "Time (LPU Std)",
    "Time (24 Hrs)",
    "Days",
    "Room",
    "Faculty",
]


class ScheduleEntryBase(BaseModel):
    program: str = Field(..., alias="Program")
    section: str = Field(..., alias="Section")
    course_code: str = Field(..., alias="Course Code")
    course_description: str = Field(..., alias="Course Description")
    units: float = Field(..., alias="Units")
    hours: float = Field(..., alias="# of Hours")
    time_lpu: str = Field(..., alias="Time (LPU Std)")
    time_24: Optional[str] = Field("", alias="Time (24 Hrs)")
    days: str = Field(..., alias="Days")
    room: str = Field(..., alias="Room")
    faculty: str = Field(..., alias="Faculty")

    class Config:
        populate_by_name = True


class ScheduleEntryCreate(ScheduleEntryBase):
    pass


class ScheduleEntryUpdate(ScheduleEntryBase):
    pass


class ScheduleEntry(ScheduleEntryBase):
    id: int

    class Config:
        from_attributes = True
        populate_by_name = True


class NamedEntity(BaseModel):
    id: int
    name: str

    class Config:
        from_attributes = True


class NamedEntityCreate(BaseModel):
    name: str


class ConflictSummary(BaseModel):
    entry_id: int
    conflicts_with: List[int]
    conflict_type: str


class ConflictReport(BaseModel):
    conflicts: List[ConflictSummary]


class SelectionRequest(BaseModel):
    ids: Optional[List[int]] = None
