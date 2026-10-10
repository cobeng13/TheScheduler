from __future__ import annotations

from typing import Any, Dict, List, Optional, Literal, Tuple

from pydantic import BaseModel, Field, FiniteFloat


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


class MoveAssignment(BaseModel):
    kind: Literal["section", "faculty", "room"]
    name: str


class MoveConflictSettings(BaseModel):
    ignore_faculty: bool = False
    ignore_room: bool = False
    ignore_tba: bool = False
    ignore_faculty_list: List[str] = Field(default_factory=list)
    ignore_room_list: List[str] = Field(default_factory=list)
    contains_faculty: bool = False
    contains_room: bool = False


class MeetingMove(BaseModel):
    source_day: str
    destination_day: str
    start_minutes: int
    assignment: Optional[MoveAssignment] = None
    expected: ScheduleEntry
    conflict_settings: MoveConflictSettings = Field(default_factory=MoveConflictSettings)
    curriculum_hours: Dict[str, FiniteFloat] = Field(default_factory=dict)


class MeetingMoveSnapshot(BaseModel):
    before: List[ScheduleEntry]
    after: List[ScheduleEntry]
    conflict_settings: MoveConflictSettings = Field(default_factory=MoveConflictSettings)
    original_conflicts: List[Tuple[int, int, str]] = Field(default_factory=list)
    signature: str


class MeetingMoveResult(BaseModel):
    entries: List[ScheduleEntry]
    snapshot: Optional[MeetingMoveSnapshot]
    moved_entry_id: int


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


class AppSettingsPayload(BaseModel):
    settings: Dict[str, Any]
