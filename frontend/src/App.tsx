import { useEffect, useMemo, useState } from "react";

type ScheduleEntry = {
  id: number;
  "Program": string;
  "Section": string;
  "Course Code": string;
  "Course Description": string;
  "Units": number;
  "# of Hours": number;
  "Time (LPU Std)": string;
  "Time (24 Hrs)": string;
  Days: string;
  Room: string;
  Faculty: string;
};

type NamedEntity = { id: number; name: string };

type ConflictSummary = {
  entry_id: number;
  conflicts_with: number[];
  conflict_type: string;
};

type ConflictReport = { conflicts: ConflictSummary[] };

type ViewMode = "text" | "timetable-class" | "timetable-faculty" | "timetable-room";

type Selection = {
  day: string;
  startIndex: number;
  endIndex: number;
} | null;

const API_BASE = "http://localhost:8000";

const canonicalHeaders = [
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
] as const;

const daysOfWeek = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins
    .toString()
    .padStart(2, "0")}`;
};

const toLpuLabel = (start: number, end: number) =>
  `${formatMinutes(start)} - ${formatMinutes(end)}`;

const overlap = (startA: number, endA: number, startB: number, endB: number) =>
  startA < endB && startB < endA;

const splitDays = (days: string) =>
  days
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean);

const parseTimeRange = (range: string) => {
  const [start, end] = range.split("-");
  const toMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  };
  return { start: toMinutes(start), end: toMinutes(end) };
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default function App() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [sections, setSections] = useState<NamedEntity[]>([]);
  const [faculty, setFaculty] = useState<NamedEntity[]>([]);
  const [rooms, setRooms] = useState<NamedEntity[]>([]);
  const [conflicts, setConflicts] = useState<ConflictReport>({ conflicts: [] });
  const [viewMode, setViewMode] = useState<ViewMode>("timetable-class");
  const [showSunday, setShowSunday] = useState(false);
  const [useQuarterHours, setUseQuarterHours] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  const [filterText, setFilterText] = useState("");
  const [sortKey, setSortKey] = useState<typeof canonicalHeaders[number]>(
    "Course Code"
  );
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [exportFilter, setExportFilter] = useState("");
  const [scheduleForm, setScheduleForm] = useState<ScheduleEntry>({
    id: 0,
    "Program": "",
    "Section": "",
    "Course Code": "",
    "Course Description": "",
    Units: 0,
    "# of Hours": 0,
    "Time (LPU Std)": "",
    "Time (24 Hrs)": "",
    Days: "",
    Room: "",
    Faculty: "",
  });
  const [newSection, setNewSection] = useState("");
  const [newFaculty, setNewFaculty] = useState("");
  const [newRoom, setNewRoom] = useState("");
  const [formError, setFormError] = useState("");
  const [editEntryId, setEditEntryId] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState<ScheduleEntry | null>(null);

  const refreshAll = async () => {
    const [scheduleRes, sectionsRes, facultyRes, roomsRes, conflictsRes] =
      await Promise.all([
        fetch(`${API_BASE}/schedule`),
        fetch(`${API_BASE}/sections`),
        fetch(`${API_BASE}/faculty`),
        fetch(`${API_BASE}/rooms`),
        fetch(`${API_BASE}/conflicts`),
      ]);
    setEntries(await scheduleRes.json());
    setSections(await sectionsRes.json());
    setFaculty(await facultyRes.json());
    setRooms(await roomsRes.json());
    setConflicts(await conflictsRes.json());
  };

  useEffect(() => {
    refreshAll();
  }, []);

  const conflictSet = useMemo(() => {
    const set = new Set<number>();
    conflicts.conflicts.forEach((conflict) => set.add(conflict.entry_id));
    return set;
  }, [conflicts]);

  const visibleDays = useMemo(() => {
    if (showSunday) {
      return daysOfWeek;
    }
    return daysOfWeek.filter((day) => day !== "Sunday");
  }, [showSunday]);

  const interval = useQuarterHours ? 15 : 30;
  const slots = useMemo(() => {
    const start = 7 * 60;
    const end = 21 * 60;
    const list: number[] = [];
    for (let minutes = start; minutes < end; minutes += interval) {
      list.push(minutes);
    }
    return list;
  }, [interval]);

  const handleSelectStart = (day: string, index: number) => {
    setSelection({ day, startIndex: index, endIndex: index });
    setContextMenu(null);
  };

  const handleSelectMove = (index: number) => {
    if (!selection) return;
    setSelection({
      ...selection,
      endIndex: index,
    });
  };

  const selectionRange = useMemo(() => {
    if (!selection) return null;
    const startIndex = Math.min(selection.startIndex, selection.endIndex);
    const endIndex = Math.max(selection.startIndex, selection.endIndex) + 1;
    const startMinutes = slots[startIndex];
    const endMinutes = slots[endIndex] ?? slots[slots.length - 1] + interval;
    return {
      day: selection.day,
      startMinutes,
      endMinutes,
    };
  }, [selection, slots, interval]);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (selectionRange) {
      setContextMenu({ x: event.clientX, y: event.clientY });
    }
  };

  const applySelectionToForm = () => {
    if (!selectionRange) return;
    const time24 = `${formatMinutes(selectionRange.startMinutes)}-${formatMinutes(
      selectionRange.endMinutes
    )}`;
    setScheduleForm((prev) => ({
      ...prev,
      "Time (24 Hrs)": time24,
      "Time (LPU Std)": prev["Time (LPU Std)"] || toLpuLabel(selectionRange.startMinutes, selectionRange.endMinutes),
      Days: selectionRange.day,
    }));
    setContextMenu(null);
  };

  const handleCreateSchedule = async () => {
    const requiredFields: Array<keyof ScheduleEntry> = [
      "Section",
      "Course Code",
      "Room",
      "Faculty",
      "Days",
      "Time (24 Hrs)",
    ];
    const missing = requiredFields.filter((field) => !scheduleForm[field]);
    if (missing.length > 0) {
      setFormError(`Missing required fields: ${missing.join(", ")}`);
      return;
    }
    setFormError("");
    const payload = {
      ...scheduleForm,
      "Time (LPU Std)":
        scheduleForm["Time (LPU Std)"] || scheduleForm["Time (24 Hrs)"],
    };
    await fetch(`${API_BASE}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setScheduleForm((prev) => ({
      ...prev,
      "Course Code": "",
      "Course Description": "",
    }));
    refreshAll();
  };

  const handleEdit = (entry: ScheduleEntry) => {
    setEditEntryId(entry.id);
    setEditEntry({ ...entry });
  };

  const handleCancelEdit = () => {
    setEditEntryId(null);
    setEditEntry(null);
  };

  const handleSaveEdit = async () => {
    if (!editEntry || editEntryId === null) return;
    await fetch(`${API_BASE}/schedule/${editEntryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editEntry),
    });
    setEditEntryId(null);
    setEditEntry(null);
    refreshAll();
  };

  const handleDeleteEntry = async (entryId: number) => {
    await fetch(`${API_BASE}/schedule/${entryId}`, { method: "DELETE" });
    refreshAll();
  };

  const handleCreateNamed = async (
    path: string,
    value: string,
    reset: () => void
  ) => {
    if (!value.trim()) return;
    await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
    reset();
    refreshAll();
  };

  const handleReset = async () => {
    const confirmed = window.confirm("This will clear the current timetable. Continue?");
    if (!confirmed) return;
    await fetch(`${API_BASE}/file/reset`, { method: "POST" });
    refreshAll();
  };

  const handleExportDb = async () => {
    const res = await fetch(`${API_BASE}/file/export`);
    const blob = await res.blob();
    downloadBlob(blob, "scheduler.db");
  };

  const handleImportDb = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    await fetch(`${API_BASE}/file/import`, { method: "POST", body: form });
    refreshAll();
  };

  const handleExport = async (path: string, filename: string) => {
    const res = await fetch(`${API_BASE}${path}`);
    const blob = await res.blob();
    downloadBlob(blob, filename);
  };

  const filteredEntries = useMemo(() => {
    const filtered = entries.filter((entry) =>
      canonicalHeaders.some((header) =>
        String(entry[header]).toLowerCase().includes(filterText.toLowerCase())
      )
    );
    const sorted = [...filtered].sort((a, b) => {
      const left = String(a[sortKey]);
      const right = String(b[sortKey]);
      return sortDirection === "asc"
        ? left.localeCompare(right)
        : right.localeCompare(left);
    });
    return sorted;
  }, [entries, filterText, sortKey, sortDirection]);

  const timetableEntries = useMemo(() => {
    if (viewMode === "timetable-class" && exportFilter) {
      return entries.filter((entry) => entry.Section === exportFilter);
    }
    if (viewMode === "timetable-faculty" && exportFilter) {
      return entries.filter((entry) => entry.Faculty === exportFilter);
    }
    if (viewMode === "timetable-room" && exportFilter) {
      return entries.filter((entry) => entry.Room === exportFilter);
    }
    return entries;
  }, [entries, exportFilter, viewMode]);

  const timetableGroup = viewMode.startsWith("timetable")
    ? viewMode.split("-")[1]
    : "class";

  const exportOptions =
    viewMode === "timetable-class"
      ? sections
      : viewMode === "timetable-faculty"
        ? faculty
        : viewMode === "timetable-room"
          ? rooms
          : [];

  const conflictDetails = useMemo(() => {
    const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
    return conflicts.conflicts.flatMap((conflict) => {
      const entry = entryMap.get(conflict.entry_id);
      if (!entry) return [];
      return conflict.conflicts_with.map((otherId) => {
        const other = entryMap.get(otherId);
        if (!other) return null;
        const entryDays = splitDays(entry.Days);
        const otherDays = splitDays(other.Days);
        const sharedDays = entryDays.filter((day) => otherDays.includes(day));
        const entryTime = parseTimeRange(entry["Time (24 Hrs)"]);
        const otherTime = parseTimeRange(other["Time (24 Hrs)"]);
        const hasOverlap = overlap(
          entryTime.start,
          entryTime.end,
          otherTime.start,
          otherTime.end
        );
        const overlapStart = Math.max(entryTime.start, otherTime.start);
        const overlapEnd = Math.min(entryTime.end, otherTime.end);
        return {
          type: conflict.conflict_type,
          entry,
          other,
          sharedDays,
          overlapTime: hasOverlap
            ? `${formatMinutes(overlapStart)}-${formatMinutes(overlapEnd)}`
            : "No overlap",
        };
      });
    }).filter(Boolean);
  }, [conflicts, entries]);

  return (
    <div className="app">
      <div className="ribbon">
        <div className="ribbon-group">
          <div className="ribbon-title">File</div>
          <button onClick={handleReset}>New Timetable</button>
          <button onClick={handleExportDb}>Save</button>
          <label className="file-input">
            Open Timetable
            <input type="file" onChange={handleImportDb} />
          </label>
        </div>
        <div className="ribbon-group">
          <div className="ribbon-title">View</div>
          <button onClick={() => setViewMode("text")}>Text View</button>
          <button onClick={() => setViewMode("timetable-class")}>
            Timetable: Per Class
          </button>
          <button onClick={() => setViewMode("timetable-faculty")}>
            Timetable: Per Faculty
          </button>
          <button onClick={() => setViewMode("timetable-room")}>
            Timetable: Per Room
          </button>
        </div>
        <div className="ribbon-group">
          <div className="ribbon-title">Export</div>
          <button onClick={() => handleExport("/reports/text.csv", "text-view.csv")}>
            Export Text View
          </button>
          <button onClick={() => handleExport("/reports/text.xlsx", "text-view.xlsx")}>
            Export Text View (.xlsx)
          </button>
          <button
            onClick={() =>
              handleExport(`/reports/timetable/${timetableGroup}.csv`, "timetable.csv")
            }
          >
            Export Timetable View
          </button>
          <button
            onClick={() =>
              handleExport(`/reports/timetable/${timetableGroup}.xlsx`, "timetable.xlsx")
            }
          >
            Export Timetable View (.xlsx)
          </button>
        </div>
      </div>

      <div className="content">
        <div className="main">
          <div className="controls">
            <label>
              Show Sunday
              <input
                type="checkbox"
                checked={showSunday}
                onChange={(event) => setShowSunday(event.target.checked)}
              />
            </label>
            <label>
              15-minute slots
              <input
                type="checkbox"
                checked={useQuarterHours}
                onChange={(event) => setUseQuarterHours(event.target.checked)}
              />
            </label>
            <label>
              Export filter
              <select
                value={exportFilter}
                onChange={(event) => setExportFilter(event.target.value)}
                disabled={!viewMode.startsWith("timetable")}
              >
                <option value="">All</option>
                {exportOptions.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {viewMode === "text" ? (
            <div className="text-view">
              <div className="text-toolbar">
                <input
                  type="search"
                  placeholder="Filter rows"
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                />
              </div>
              <table>
                <thead>
                  <tr>
                    {canonicalHeaders.map((header) => (
                      <th
                        key={header}
                        onClick={() => {
                          if (sortKey === header) {
                            setSortDirection(sortDirection === "asc" ? "desc" : "asc");
                          } else {
                            setSortKey(header);
                            setSortDirection("asc");
                          }
                        }}
                      >
                        {header}
                      </th>
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry) => (
                    <tr key={entry.id} className={conflictSet.has(entry.id) ? "conflict" : ""}>
                      {canonicalHeaders.map((header) => (
                        <td key={header}>
                          {editEntryId === entry.id && editEntry ? (
                            <input
                              value={String(editEntry[header])}
                              onChange={(event) =>
                                setEditEntry({
                                  ...editEntry,
                                  [header]:
                                    header === "Units" || header === "# of Hours"
                                      ? Number(event.target.value)
                                      : event.target.value,
                                } as ScheduleEntry)
                              }
                            />
                          ) : (
                            entry[header]
                          )}
                        </td>
                      ))}
                      <td>
                        {editEntryId === entry.id ? (
                          <>
                            <button onClick={handleSaveEdit}>Save</button>
                            <button onClick={handleCancelEdit}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => handleEdit(entry)}>Edit</button>
                            <button onClick={() => handleDeleteEntry(entry.id)}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="timetable" onContextMenu={handleContextMenu}>
              <div
                className="day-headers"
                style={{
                  gridTemplateColumns: `120px repeat(${visibleDays.length}, 1fr)`,
                }}
              >
                <div className="time-header">Time</div>
                {visibleDays.map((day) => (
                  <div key={day} className="day-header">
                    {day}
                  </div>
                ))}
              </div>
              <div
                className="timetable-grid"
                style={{
                  gridTemplateColumns: `120px repeat(${visibleDays.length}, 1fr)`,
                  gridTemplateRows: `repeat(${slots.length}, 40px)`,
                }}
              >
                {slots.map((slot, rowIndex) => (
                  <div key={`time-${slot}`} className="time-cell" style={{ gridRow: rowIndex + 1 }}>
                    {formatMinutes(slot)}
                  </div>
                ))}
                {visibleDays.map((day, dayIndex) =>
                  slots.map((slot, rowIndex) => (
                    <div
                      key={`${day}-${slot}`}
                      className={`cell ${
                        selectionRange &&
                        selectionRange.day === day &&
                        slot >= selectionRange.startMinutes &&
                        slot < selectionRange.endMinutes
                          ? "selected"
                          : ""
                      }`}
                      style={{ gridColumn: dayIndex + 2, gridRow: rowIndex + 1 }}
                      onMouseDown={() => handleSelectStart(day, rowIndex)}
                      onMouseEnter={() => handleSelectMove(rowIndex)}
                      onMouseUp={() => setSelection((prev) => prev)}
                    />
                  ))
                )}
                {timetableEntries.flatMap((entry) => {
                  const days = entry.Days.split(",").map((d) => d.trim());
                  const { start, end } = parseTimeRange(entry["Time (24 Hrs)"]);
                  const startIndex = Math.max(
                    0,
                    slots.findIndex((slot) => slot >= start)
                  );
                  const endIndex = Math.max(
                    startIndex + 1,
                    slots.findIndex((slot) => slot >= end)
                  );
                  return days
                    .filter((day) => visibleDays.includes(day))
                    .map((day) => {
                      const column = visibleDays.indexOf(day) + 2;
                      return (
                        <div
                          key={`${entry.id}-${day}`}
                          className={`block ${conflictSet.has(entry.id) ? "conflict" : ""}`}
                          style={{
                            gridColumn: column,
                            gridRow: `${startIndex + 1} / ${Math.max(endIndex, startIndex + 1) + 1}`,
                          }}
                        >
                          <div className="block-title">{entry["Course Code"]}</div>
                          <div>{entry.Section}</div>
                          <div>{entry.Room}</div>
                          <div>{entry.Faculty}</div>
                        </div>
                      );
                    });
                })}
              </div>
              {contextMenu && (
                <div
                  className="context-menu"
                  style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                  <button onClick={applySelectionToForm}>Add Class</button>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="panel">
          <h3>Add Class</h3>
          <label>
            Program
            <input
              value={scheduleForm.Program}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Program: event.target.value })
              }
            />
          </label>
          <label>
            Section
            <input
              value={scheduleForm.Section}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Section: event.target.value })
              }
              list="section-list"
            />
            <datalist id="section-list">
              {sections.map((section) => (
                <option key={section.id} value={section.name} />
              ))}
            </datalist>
          </label>
          <label>
            Course Code
            <input
              value={scheduleForm["Course Code"]}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  "Course Code": event.target.value,
                })
              }
            />
          </label>
          <label>
            Course Description
            <input
              value={scheduleForm["Course Description"]}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  "Course Description": event.target.value,
                })
              }
            />
          </label>
          <label>
            Units
            <input
              type="number"
              value={scheduleForm.Units}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  Units: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            # of Hours
            <input
              type="number"
              value={scheduleForm["# of Hours"]}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  "# of Hours": Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Time (LPU Std)
            <input
              value={scheduleForm["Time (LPU Std)"]}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  "Time (LPU Std)": event.target.value,
                })
              }
            />
          </label>
          <label>
            Time (24 Hrs)
            <input
              value={scheduleForm["Time (24 Hrs)"]}
              onChange={(event) =>
                setScheduleForm({
                  ...scheduleForm,
                  "Time (24 Hrs)": event.target.value,
                })
              }
            />
          </label>
          <label>
            Days
            <input
              value={scheduleForm.Days}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Days: event.target.value })
              }
            />
          </label>
          <label>
            Room
            <input
              value={scheduleForm.Room}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Room: event.target.value })
              }
              list="room-list"
            />
            <datalist id="room-list">
              {rooms.map((room) => (
                <option key={room.id} value={room.name} />
              ))}
            </datalist>
          </label>
          <label>
            Faculty
            <input
              value={scheduleForm.Faculty}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Faculty: event.target.value })
              }
              list="faculty-list"
            />
            <datalist id="faculty-list">
              {faculty.map((member) => (
                <option key={member.id} value={member.name} />
              ))}
            </datalist>
          </label>
          <button onClick={handleCreateSchedule}>Add Class</button>
          {formError && <p className="error">{formError}</p>}

          <h3>Add Section</h3>
          <label>
            Name
            <input
              value={newSection}
              onChange={(event) => setNewSection(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              handleCreateNamed("sections", newSection, () => setNewSection(""))
            }
          >
            Add Section
          </button>

          <h3>Add Faculty</h3>
          <label>
            Name
            <input
              value={newFaculty}
              onChange={(event) => setNewFaculty(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              handleCreateNamed("faculty", newFaculty, () => setNewFaculty(""))
            }
          >
            Add Faculty
          </button>

          <h3>Add Room</h3>
          <label>
            Name
            <input value={newRoom} onChange={(event) => setNewRoom(event.target.value)} />
          </label>
          <button
            onClick={() =>
              handleCreateNamed("rooms", newRoom, () => setNewRoom(""))
            }
          >
            Add Room
          </button>
          <h3>Conflicts</h3>
          {conflictDetails.length === 0 ? (
            <p className="muted">No conflicts detected.</p>
          ) : (
            <ul className="conflict-list">
              {conflictDetails.map((conflict, index) => (
                <li key={`${conflict?.entry.id}-${conflict?.other.id}-${index}`}>
                  <strong>{conflict?.type.toUpperCase()}</strong>: {conflict?.entry["Course Code"]}{" "}
                  ({conflict?.entry.Section}) vs {conflict?.other["Course Code"]} (
                  {conflict?.other.Section}) on {conflict?.sharedDays.join(", ")} at{" "}
                  {conflict?.overlapTime}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
