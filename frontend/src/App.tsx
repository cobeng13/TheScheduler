import html2canvas from "html2canvas";
import { useEffect, useMemo, useRef, useState } from "react";

type ScheduleEntry = {
  id: number;
  "Program": string;
  "Section": string;
  "Course Code": string;
  "Course Description": string;
  "Units": number;
  "# of Hours": number;
  "Time (LPU Std)": string;
  "Time (24 Hrs)": string | null;
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

type CsvImportSummary = {
  rows_total: number;
  rows_imported: number;
  rows_skipped: number;
  missing_columns: string[];
  errors: Array<{ row_index: number; reason: string }>;
};

type ViewMode = "text" | "timetable-section" | "timetable-faculty" | "timetable-room";

type Selection = {
  day: string;
  startIndex: number;
  endIndex: number;
} | null;

type MoveSnapshot = {
  previousEntries: ScheduleEntry[];
  createdEntryId?: number;
  deletedEntry?: ScheduleEntry;
};

type CustomizeSettings = {
  blockDisplay: {
    showCourseCode: boolean;
    showRoom: boolean;
    showFaculty: boolean;
    useFacultyColors: boolean;
  };
  facultyColors: Record<string, string>;
  sectionBgColors: Record<string, string>;
};

const API_BASE = "http://localhost:8000";
const CUSTOMIZE_STORAGE_KEY = "scheduler.customize";

const defaultCustomizeSettings: CustomizeSettings = {
  blockDisplay: {
    showCourseCode: true,
    showRoom: true,
    showFaculty: true,
    useFacultyColors: false,
  },
  facultyColors: {},
  sectionBgColors: {},
};

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

const daysOfWeek = ["M", "T", "W", "Th", "F", "Sa", "Su"];
const dayLabels: Record<string, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  Th: "Thursday",
  F: "Friday",
  Sa: "Saturday",
  Su: "Sunday",
};

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins
    .toString()
    .padStart(2, "0")}`;
};

const toLpuStd = (minutes: number) => {
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const meridian = hours24 >= 12 ? "p" : "a";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${mins.toString().padStart(2, "0")}${meridian}`;
};

const toLpuLabel = (start: number, end: number) => `${toLpuStd(start)}-${toLpuStd(end)}`;

const toTimeRange24 = (start: number, end: number) =>
  `${formatMinutes(start)}-${formatMinutes(end)}`;

const overlap = (startA: number, endA: number, startB: number, endB: number) =>
  startA < endB && startB < endA;

const splitDays = (days: string) =>
  normalizeDays(days)
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean);

const parseTimeRange = (range: string | null) => {
  if (!range) return null;
  const [start, end] = range.split("-");
  if (!start || !end) return null;
  const toMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === null || endMinutes === null) return null;
  return { start: startMinutes, end: endMinutes };
};

const parseLpuRange = (range: string) => {
  const cleaned = range.trim();
  if (!cleaned || cleaned.toLowerCase() === "tba") {
    return null;
  }
  const match = cleaned
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*([ap])\s*-\s*(\d{1,2}):(\d{2})\s*([ap])$/i);
  if (!match) {
    return null;
  }
  const [, startH, startM, startMeridian, endH, endM, endMeridian] = match;
  const toMinutes = (hours: number, minutes: number, meridian: string) => {
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      return null;
    }
    const isPm = meridian.toLowerCase() === "p";
    const normalizedHours = hours % 12 + (isPm ? 12 : 0);
    return normalizedHours * 60 + minutes;
  };
  const startMinutes = toMinutes(Number(startH), Number(startM), startMeridian);
  const endMinutes = toMinutes(Number(endH), Number(endM), endMeridian);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    return null;
  }
  const time24 = `${formatMinutes(startMinutes)}-${formatMinutes(endMinutes)}`;
  return { time24, startMinutes, endMinutes };
};

const getReadableTextColor = (hex: string) => {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) return "#ffffff";
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#1c1c1c" : "#ffffff";
};

const isValidHex = (value: string) => /^#?[0-9a-fA-F]{6}$/.test(value.trim());

const normalizeHex = (value: string) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!isValidHex(trimmed)) return "";
  return trimmed.startsWith("#") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
};

const hexToRgb = (hex: string) => {
  const cleaned = normalizeHex(hex).replace("#", "");
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return { r, g, b };
};

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;

const sanitizeFilename = (value: string) =>
  value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
};

const hslToHex = (hue: number, saturation: number, lightness: number) => {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const colorPalette = [
  "#4A90E2",
  "#50E3C2",
  "#F5A623",
  "#BD10E0",
  "#7ED321",
  "#D0021B",
  "#9013FE",
  "#8B572A",
  "#417505",
  "#B8E986",
  "#F8E71C",
  "#4A4A4A",
];

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const sortEntities = (items: NamedEntity[]) =>
  [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

const normalizeDays = (value: string) => {
  if (!value) return "";
  const aliasMap: Record<string, string> = {
    m: "M",
    mon: "M",
    monday: "M",
    t: "T",
    tu: "T",
    tue: "T",
    tues: "T",
    tuesday: "T",
    w: "W",
    wed: "W",
    weds: "W",
    wednesday: "W",
    th: "Th",
    thu: "Th",
    thur: "Th",
    thurs: "Th",
    thursday: "Th",
    f: "F",
    fri: "F",
    friday: "F",
    sa: "Sa",
    sat: "Sa",
    saturday: "Sa",
    su: "Su",
    sun: "Su",
    sunday: "Su",
  };
  const cleaned = value.replace("/", ",").replace(/\s+/g, ",");
  const parts = cleaned.split(",").filter(Boolean);
  const tokens: string[] =
    parts.length === 1 && parts[0].length > 2 && /^[a-z]+$/i.test(parts[0])
      ? parts[0]
          .replace(/th/gi, "Th,")
          .replace(/sa/gi, "Sa,")
          .replace(/su/gi, "Su,")
          .split(",")
          .filter(Boolean)
          .map((part) => aliasMap[part.toLowerCase()] ?? part)
      : parts.map((part) => aliasMap[part.toLowerCase()] ?? part);
  const canonical = tokens.filter((token) => dayLabels[token]);
  return canonical.join(",");
};

export default function App() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [sections, setSections] = useState<NamedEntity[]>([]);
  const [faculty, setFaculty] = useState<NamedEntity[]>([]);
  const [rooms, setRooms] = useState<NamedEntity[]>([]);
  const [conflicts, setConflicts] = useState<ConflictReport>({ conflicts: [] });
  const [viewMode, setViewMode] = useState<ViewMode>("timetable-section");
  const [showSunday, setShowSunday] = useState(false);
  const [useQuarterHours, setUseQuarterHours] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [selectionEnd, setSelectionEnd] = useState<Selection>(null);
  const [lastSelection, setLastSelection] = useState<{
    day: string;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; entry: ScheduleEntry } | null>(
    null
  );
  const [filterText, setFilterText] = useState("");
  const [sortKey, setSortKey] = useState<typeof canonicalHeaders[number]>(
    "Course Code"
  );
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [selectedSection, setSelectedSection] = useState("");
  const [selectedFaculty, setSelectedFaculty] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const [timetableEntries, setTimetableEntries] = useState<ScheduleEntry[]>([]);
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
  const [editError, setEditError] = useState("");
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionOrigin, setSelectionOrigin] = useState<{ day: string; index: number } | null>(
    null
  );
  const [dragging, setDragging] = useState<{
    entry: ScheduleEntry;
    day: string;
    duration: number;
  } | null>(null);
  const [dragTarget, setDragTarget] = useState<{ day: string; startMinutes: number } | null>(
    null
  );
  const [toast, setToast] = useState<{ message: string; showRevert: boolean } | null>(null);
  const [moveSnapshot, setMoveSnapshot] = useState<MoveSnapshot | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [formEditId, setFormEditId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    current: number;
    total: number;
    label: string;
    running: boolean;
  } | null>(null);
  const [exportCancelRequested, setExportCancelRequested] = useState(false);
  const [exportRender, setExportRender] = useState<{
    title: string;
    entries: ScheduleEntry[];
    mode: ViewMode;
    selectionName: string;
    titleColor?: string;
  } | null>(null);
  const [openExportSubmenu, setOpenExportSubmenu] = useState(false);
  const [ignoreFaculty, setIgnoreFaculty] = useState(false);
  const [ignoreRoom, setIgnoreRoom] = useState(false);
  const [ignoreTba, setIgnoreTba] = useState(false);
  const [ignoreFacultyList, setIgnoreFacultyList] = useState<string[]>([]);
  const [ignoreRoomList, setIgnoreRoomList] = useState<string[]>([]);
  const [containsFaculty, setContainsFaculty] = useState(false);
  const [containsRoom, setContainsRoom] = useState(false);
  const [facultyInput, setFacultyInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [openMenu, setOpenMenu] = useState<"file" | "export" | "rules" | null>(null);
  const [showFacultyRules, setShowFacultyRules] = useState(false);
  const [showRoomRules, setShowRoomRules] = useState(false);
  const [csvImportState, setCsvImportState] = useState<{
    file: File;
    summary: CsvImportSummary;
  } | null>(null);
  const [isCsvImporting, setIsCsvImporting] = useState(false);
  const [csvInputKey, setCsvInputKey] = useState(0);
  const [customizeSettings, setCustomizeSettings] =
    useState<CustomizeSettings>(defaultCustomizeSettings);
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [selectedFacultyColor, setSelectedFacultyColor] = useState("");
  const [facultyColorInput, setFacultyColorInput] = useState("");
  const [facultyRgb, setFacultyRgb] = useState({ r: 0, g: 0, b: 0 });
  const [showFacultyAdvanced, setShowFacultyAdvanced] = useState(false);
  const [selectedSectionColor, setSelectedSectionColor] = useState("");
  const [sectionColorInput, setSectionColorInput] = useState("");
  const [sectionRgb, setSectionRgb] = useState({ r: 0, g: 0, b: 0 });
  const [showSectionAdvanced, setShowSectionAdvanced] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const courseCodeRef = useRef<HTMLInputElement | null>(null);
  const timetableRef = useRef<HTMLDivElement | null>(null);
  const exportRenderRef = useRef<HTMLDivElement | null>(null);
  const exportCancelRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const customizeModalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const storedProgram = localStorage.getItem("lastProgram");
    const storedSection = localStorage.getItem("lastSection");
    const storedZoom = localStorage.getItem("timetableZoom");
    const storedIgnoreFaculty = localStorage.getItem("rulesIgnoreFaculty");
    const storedIgnoreRoom = localStorage.getItem("rulesIgnoreRoom");
    const storedIgnoreTba = localStorage.getItem("rulesIgnoreTba");
    const storedIgnoreFacultyList = localStorage.getItem("rulesIgnoreFacultyList");
    const storedIgnoreRoomList = localStorage.getItem("rulesIgnoreRoomList");
    const storedContainsFaculty = localStorage.getItem("rulesContainsFaculty");
    const storedContainsRoom = localStorage.getItem("rulesContainsRoom");
    setScheduleForm((prev) => ({
      ...prev,
      Program: storedProgram ?? prev.Program,
      Section: storedSection ?? prev.Section,
    }));
    if (storedZoom) {
      const parsed = Number(storedZoom);
      if (!Number.isNaN(parsed)) {
        setZoomPercent(parsed);
      }
    }
    if (storedIgnoreFaculty) {
      setIgnoreFaculty(storedIgnoreFaculty === "true");
    }
    if (storedIgnoreRoom) {
      setIgnoreRoom(storedIgnoreRoom === "true");
    }
    if (storedIgnoreTba) {
      setIgnoreTba(storedIgnoreTba === "true");
    }
    if (storedIgnoreFacultyList) {
      setIgnoreFacultyList(storedIgnoreFacultyList.split("|").filter(Boolean));
    }
    if (storedIgnoreRoomList) {
      setIgnoreRoomList(storedIgnoreRoomList.split("|").filter(Boolean));
    }
    if (storedContainsFaculty) {
      setContainsFaculty(storedContainsFaculty === "true");
    }
    if (storedContainsRoom) {
      setContainsRoom(storedContainsRoom === "true");
    }
    const storedCustomize = localStorage.getItem(CUSTOMIZE_STORAGE_KEY);
    if (storedCustomize) {
      try {
        const parsed = JSON.parse(storedCustomize) as CustomizeSettings;
        setCustomizeSettings({
          ...defaultCustomizeSettings,
          ...parsed,
          blockDisplay: {
            ...defaultCustomizeSettings.blockDisplay,
            ...parsed.blockDisplay,
          },
        });
      } catch {
        setCustomizeSettings(defaultCustomizeSettings);
      }
    }
  }, []);

  const fetchConflicts = async () => {
    const params = new URLSearchParams();
    params.set("ignore_faculty", String(ignoreFaculty));
    params.set("ignore_room", String(ignoreRoom));
    params.set("ignore_tba", String(ignoreTba));
    if (ignoreFacultyList.length > 0) {
      params.set("ignore_faculty_list", ignoreFacultyList.join(","));
    }
    if (ignoreRoomList.length > 0) {
      params.set("ignore_room_list", ignoreRoomList.join(","));
    }
    params.set("contains_faculty", String(containsFaculty));
    params.set("contains_room", String(containsRoom));
    const conflictsRes = await fetch(`${API_BASE}/conflicts?${params.toString()}`);
    setConflicts(await conflictsRes.json());
  };

  const refreshAll = async () => {
    const [scheduleRes, sectionsRes, facultyRes, roomsRes] = await Promise.all([
      fetch(`${API_BASE}/schedule`),
      fetch(`${API_BASE}/sections`),
      fetch(`${API_BASE}/faculty`),
      fetch(`${API_BASE}/rooms`),
    ]);
    setEntries(await scheduleRes.json());
    setSections(await sectionsRes.json());
    setFaculty(await facultyRes.json());
    setRooms(await roomsRes.json());
    await fetchConflicts();
    if (currentViewConfig.selected && viewMode.startsWith("timetable")) {
      await fetchTimetableForSelection(currentViewConfig.selected, viewMode);
    }
  };

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    localStorage.setItem("rulesIgnoreFaculty", String(ignoreFaculty));
    localStorage.setItem("rulesIgnoreRoom", String(ignoreRoom));
    localStorage.setItem("rulesIgnoreTba", String(ignoreTba));
    localStorage.setItem("rulesIgnoreFacultyList", ignoreFacultyList.join("|"));
    localStorage.setItem("rulesIgnoreRoomList", ignoreRoomList.join("|"));
    localStorage.setItem("rulesContainsFaculty", String(containsFaculty));
    localStorage.setItem("rulesContainsRoom", String(containsRoom));
    fetchConflicts();
  }, [
    ignoreFaculty,
    ignoreRoom,
    ignoreTba,
    ignoreFacultyList,
    ignoreRoomList,
    containsFaculty,
    containsRoom,
  ]);

  useEffect(() => {
    localStorage.setItem(CUSTOMIZE_STORAGE_KEY, JSON.stringify(customizeSettings));
  }, [customizeSettings]);

  useEffect(() => {
    if (!openMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) {
      setShowFacultyRules(false);
      setShowRoomRules(false);
      setOpenExportSubmenu(false);
    }
  }, [openMenu]);

  useEffect(() => {
    if (!isCustomizeOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!customizeModalRef.current) return;
      if (!customizeModalRef.current.contains(event.target as Node)) {
        setIsCustomizeOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsCustomizeOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isCustomizeOpen]);

  const fetchTimetableForSelection = async (selectionName: string, mode: ViewMode) => {
    if (!mode.startsWith("timetable") || !selectionName) {
      setTimetableEntries([]);
      return;
    }
    const params = new URLSearchParams();
    if (mode === "timetable-section") {
      params.set("section", selectionName);
    } else if (mode === "timetable-faculty") {
      params.set("faculty", selectionName);
    } else if (mode === "timetable-room") {
      params.set("room", selectionName);
    }
    const res = await fetch(`${API_BASE}/schedule?${params.toString()}`);
    setTimetableEntries(await res.json());
  };

  const sectionOptions = useMemo(() => sortEntities(sections), [sections]);
  const facultyOptions = useMemo(() => sortEntities(faculty), [faculty]);
  const roomOptions = useMemo(() => sortEntities(rooms), [rooms]);

  useEffect(() => {
    if (!selectedFacultyColor && facultyOptions.length > 0) {
      setSelectedFacultyColor(facultyOptions[0].name);
    }
  }, [facultyOptions, selectedFacultyColor]);

  useEffect(() => {
    if (!selectedSectionColor && sectionOptions.length > 0) {
      setSelectedSectionColor(sectionOptions[0].name);
    }
  }, [sectionOptions, selectedSectionColor]);

  useEffect(() => {
    if (!selectedFacultyColor) return;
    setFacultyColorInput(customizeSettings.facultyColors[selectedFacultyColor] ?? "");
  }, [selectedFacultyColor, customizeSettings.facultyColors]);

  useEffect(() => {
    if (!selectedSectionColor) return;
    setSectionColorInput(customizeSettings.sectionBgColors[selectedSectionColor] ?? "");
  }, [selectedSectionColor, customizeSettings.sectionBgColors]);

  useEffect(() => {
    const rgb = hexToRgb(facultyColorInput);
    if (!rgb) return;
    setFacultyRgb(rgb);
  }, [facultyColorInput]);

  useEffect(() => {
    const rgb = hexToRgb(sectionColorInput);
    if (!rgb) return;
    setSectionRgb(rgb);
  }, [sectionColorInput]);

  const currentViewConfig = useMemo(() => {
    if (viewMode === "timetable-section") {
      return {
        label: "sections",
        entities: sectionOptions,
        selected: selectedSection,
        setSelected: setSelectedSection,
      };
    }
    if (viewMode === "timetable-faculty") {
      return {
        label: "faculty",
        entities: facultyOptions,
        selected: selectedFaculty,
        setSelected: setSelectedFaculty,
      };
    }
    if (viewMode === "timetable-room") {
      return {
        label: "rooms",
        entities: roomOptions,
        selected: selectedRoom,
        setSelected: setSelectedRoom,
      };
    }
    return {
      label: "",
      entities: [],
      selected: "",
      setSelected: () => {},
    };
  }, [
    viewMode,
    sectionOptions,
    facultyOptions,
    roomOptions,
    selectedSection,
    selectedFaculty,
    selectedRoom,
  ]);

  useEffect(() => {
    if (!viewMode.startsWith("timetable")) {
      return;
    }
    if (currentViewConfig.entities.length === 0) {
      setTimetableEntries([]);
      return;
    }
    if (!currentViewConfig.selected) {
      currentViewConfig.setSelected(currentViewConfig.entities[0].name);
    }
  }, [viewMode, currentViewConfig]);

  useEffect(() => {
    if (!viewMode.startsWith("timetable")) {
      return;
    }
    if (!currentViewConfig.selected) {
      setTimetableEntries([]);
      return;
    }
    fetchTimetableForSelection(currentViewConfig.selected, viewMode);
  }, [viewMode, currentViewConfig.selected]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dragging) {
          setDragging(null);
          setDragTarget(null);
        }
        setLastSelection(null);
        setSelection(null);
        setSelectionEnd(null);
        setSelectionOrigin(null);
        setBlockMenu(null);
        setContextMenu(null);
      }
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".timetable")) {
        setLastSelection(null);
        setSelection(null);
        setSelectionEnd(null);
        setSelectionOrigin(null);
      }
      if (!target?.closest(".block-menu")) {
        setBlockMenu(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, []);

  useEffect(() => {
    if (!toast || toast.showRevert || isExporting) return;
    const timeout = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast, isExporting]);

  const conflictSet = useMemo(() => {
    const set = new Set<number>();
    conflicts.conflicts.forEach((conflict) => set.add(conflict.entry_id));
    return set;
  }, [conflicts]);

  const visibleDays = useMemo(() => {
    if (showSunday) {
      return daysOfWeek;
    }
    return daysOfWeek.filter((day) => day !== "Su");
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

  const handleSelectStart = (event: React.MouseEvent, day: string, index: number) => {
    if (event.button !== 0) return;
    setSelection({ day, startIndex: index, endIndex: index });
    setSelectionEnd({ day, startIndex: index, endIndex: index });
    setSelectionOrigin({ day, index });
    setContextMenu(null);
    setIsSelecting(true);
  };

  const handleSelectMove = (day: string, index: number) => {
    if (!selection || !isSelecting) return;
    if (selection.day !== day) {
      return;
    }
    setSelectionEnd({ day, startIndex: selection.startIndex, endIndex: index });
  };

  const finalizeSelection = () => {
    if (!selection || !selectionEnd || !selectionOrigin) {
      setIsSelecting(false);
      return;
    }
    const startIndex = Math.min(selectionOrigin.index, selectionEnd.endIndex);
    const endIndex = Math.max(selectionOrigin.index, selectionEnd.endIndex) + 1;
    const startMinutes = slots[startIndex];
    const endMinutes = slots[endIndex] ?? slots[slots.length - 1] + interval;
    setLastSelection({
      day: selection.day,
      startMinutes,
      endMinutes,
    });
    setIsSelecting(false);
    setSelectionOrigin(null);
  };

  const handleDragStart = (entry: ScheduleEntry, day: string) => {
    const parsed = parseTimeRange(entry["Time (24 Hrs)"]);
    if (!parsed) return;
    const { start, end } = parsed;
    setDragging({ entry, day, duration: end - start });
    setDragTarget({ day, startMinutes: start });
    setToast(null);
    setMoveSnapshot(null);
  };

  const handleDragOver = (event: React.DragEvent, day: string, slot: number) => {
    event.preventDefault();
    if (!dragging) return;
    setDragTarget({ day, startMinutes: slot });
  };

  const hasConflict = (candidate: ScheduleEntry, candidateDay: string, start: number, end: number) =>
    entries.some((entry) => {
      if (entry.id === candidate.id) return false;
      const entryDays = splitDays(entry.Days);
      if (!entryDays.includes(candidateDay)) return false;
      const entryTime = parseTimeRange(entry["Time (24 Hrs)"]);
      if (!entryTime) return false;
      if (!overlap(start, end, entryTime.start, entryTime.end)) return false;
      return entry.Room === candidate.Room || entry.Faculty === candidate.Faculty;
    });

  const handleDrop = async () => {
    if (!dragging || !dragTarget) return;
    const { entry, day: originDay, duration } = dragging;
    const startMinutes = dragTarget.startMinutes;
    const endMinutes = startMinutes + duration;
    const newTime24 = toTimeRange24(startMinutes, endMinutes);
    const newTimeLpu = toLpuLabel(startMinutes, endMinutes);
    const days = normalizeDays(entry.Days).split(",").filter(Boolean);
    const payloadBase = {
      ...entry,
      Days: dragTarget.day,
      "Time (24 Hrs)": newTime24,
      "Time (LPU Std)": newTimeLpu,
    };

    const snapshot: MoveSnapshot = { previousEntries: [entry] };

    if (hasConflict(entry, dragTarget.day, startMinutes, endMinutes)) {
      setToast({ message: "Move blocked — conflict detected", showRevert: false });
      setDragging(null);
      setDragTarget(null);
      return;
    }

    if (isSaving) return;
    setIsSaving(true);
    if (days.length > 1) {
      const remaining = days.filter((token) => token !== originDay);
      if (remaining.length > 0) {
        await fetch(`${API_BASE}/schedule/${entry.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...entry, Days: remaining.join(",") }),
        });
      } else {
        await fetch(`${API_BASE}/schedule/${entry.id}`, { method: "DELETE" });
        snapshot.deletedEntry = entry;
      }
      const { id: _id, ...createPayload } = payloadBase;
      const createResponse = await fetch(`${API_BASE}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPayload),
      });
      const created = await createResponse.json();
      snapshot.createdEntryId = created.id;
    } else {
      await fetch(`${API_BASE}/schedule/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadBase),
      });
    }

    setMoveSnapshot(snapshot);
    await refreshAll();
    setDragging(null);
    setDragTarget(null);
    setLastSelection(null);
    setSelection(null);
    setSelectionEnd(null);
    setSelectionOrigin(null);
    setToast({
      message: "Move saved",
      showRevert: false,
    });
    setIsSaving(false);
  };

  const handleRevertMove = async () => {
    if (!moveSnapshot) return;
    if (isSaving) return;
    setIsSaving(true);
    if (moveSnapshot.createdEntryId) {
      await fetch(`${API_BASE}/schedule/${moveSnapshot.createdEntryId}`, { method: "DELETE" });
    }
    if (moveSnapshot.deletedEntry) {
      const { id, ...rest } = moveSnapshot.deletedEntry;
      await fetch(`${API_BASE}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
    }
    for (const entry of moveSnapshot.previousEntries) {
      await fetch(`${API_BASE}/schedule/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
    }
    setMoveSnapshot(null);
    setToast({ message: "Move reverted", showRevert: false });
    await refreshAll();
    setIsSaving(false);
  };

  const selectionRange = useMemo(() => {
    if (isSelecting && selectionOrigin && selectionEnd) {
      const startIndex = Math.min(selectionOrigin.index, selectionEnd.endIndex);
      const endIndex = Math.max(selectionOrigin.index, selectionEnd.endIndex) + 1;
      const startMinutes = slots[startIndex];
      const endMinutes = slots[endIndex] ?? slots[slots.length - 1] + interval;
      return {
        day: selectionOrigin.day,
        startMinutes,
        endMinutes,
      };
    }
    return lastSelection;
  }, [isSelecting, selectionOrigin, selectionEnd, lastSelection, slots, interval]);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const cell = target?.closest<HTMLElement>("[data-day][data-slot]");
    const inGrid = Boolean(target?.closest(".timetable-grid"));
    if (target?.closest(".block")) {
      return;
    }
    if (selectionRange) {
      if (inGrid) {
        if (!cell) {
          setContextMenu({ x: event.clientX, y: event.clientY });
          return;
        }
        const day = cell.dataset.day ?? "";
        const slot = Number(cell.dataset.slot ?? 0);
        if (
          selectionRange.day === day &&
          slot >= selectionRange.startMinutes &&
          slot < selectionRange.endMinutes
        ) {
          setContextMenu({ x: event.clientX, y: event.clientY });
        }
        return;
      }
      setContextMenu({ x: event.clientX, y: event.clientY });
      return;
    }
    if (!cell) return;
    const day = cell.dataset.day ?? "";
    const slot = Number(cell.dataset.slot ?? 0);
    const endMinutes = slot + interval;
    setLastSelection({ day, startMinutes: slot, endMinutes });
    setContextMenu({ x: event.clientX, y: event.clientY });
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

  const handleBlockContextMenu = (event: React.MouseEvent, entry: ScheduleEntry) => {
    event.preventDefault();
    setBlockMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const enterEditMode = (entry: ScheduleEntry) => {
    setFormEditId(entry.id);
    setScheduleForm(entry);
    setFormError("");
    setBlockMenu(null);
    if (panelRef.current) {
      panelRef.current.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => {
        courseCodeRef.current?.focus();
      }, 150);
    }
  };

  const cancelEditMode = () => {
    setFormEditId(null);
    setFormError("");
  };

  const saveFormEdit = async () => {
    if (formEditId === null) return;
    if (isSaving) return;
    const parsed = parseLpuRange(scheduleForm["Time (LPU Std)"]);
    if (!parsed) {
      setFormError("Invalid Time (LPU Std). Example: 10:00a-12:00p");
      return;
    }
    const normalizedDays = normalizeDays(scheduleForm.Days);
    if (!normalizedDays) {
      setFormError("Invalid Days. Example: M,W,F");
      return;
    }
    setIsSaving(true);
    const payload = { ...scheduleForm, Days: normalizedDays };
    await fetch(`${API_BASE}/schedule/${formEditId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setFormEditId(null);
    setToast({ message: "Saved", showRevert: false });
    await refreshAll();
    setIsSaving(false);
  };

  const deleteEntry = async (entry: ScheduleEntry) => {
    if (isSaving) return;
    const confirmed = window.confirm("Delete this class?");
    if (!confirmed) return;
    setIsSaving(true);
    await fetch(`${API_BASE}/schedule/${entry.id}`, { method: "DELETE" });
    setBlockMenu(null);
    setToast({ message: "Deleted", showRevert: false });
    await refreshAll();
    setIsSaving(false);
  };

  const captureElementToPng = async (element: HTMLElement) => {
    element.classList.add("export-mode");
    const previousHeight = element.style.height;
    const previousOverflow = element.style.overflow;
    element.style.height = `${element.scrollHeight}px`;
    element.style.overflow = "visible";
    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale: 2,
    });
    element.style.height = previousHeight;
    element.style.overflow = previousOverflow;
    element.classList.remove("export-mode");
    return canvas.toDataURL("image/png");
  };

  const exportTimetablePng = async (selectionOverride?: string, modeOverride?: ViewMode) => {
    const selectionName = selectionOverride ?? currentViewConfig.selected;
    if (!timetableRef.current || !selectionName) return;
    if (isExporting) return;
    setIsExporting(true);
    setToast({ message: "Exporting PNG...", showRevert: false });
    const dataUrl = await captureElementToPng(timetableRef.current);
    const link = document.createElement("a");
    const modeLabel = (modeOverride ?? viewMode).split("-")[1] ?? "timetable";
    const safeName = selectionName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/(^_|_$)/g, "");
    link.download = `timetable_${modeLabel}_${safeName || "export"}.png`;
    link.href = dataUrl;
    link.click();
    setToast({ message: "Exported", showRevert: false });
    setIsExporting(false);
  };

  const exportBatch = async (
    category: "faculty" | "section" | "room",
    items: NamedEntity[]
  ) => {
    if (!exportRenderRef.current) return;
    if (items.length === 0) return;
    exportCancelRef.current = false;
    setExportCancelRequested(false);
    setIsExporting(true);
    const total = items.length;
    for (let index = 0; index < items.length; index += 1) {
      if (exportCancelRef.current) break;
      const item = items[index];
      const sanitizedName = sanitizeFilename(item.name);
      if (!sanitizedName) continue;
      const mode =
        category === "faculty"
          ? "timetable-faculty"
          : category === "section"
            ? "timetable-section"
            : "timetable-room";
      const params = new URLSearchParams();
      if (mode === "timetable-section") {
        params.set("section", item.name);
      } else if (mode === "timetable-faculty") {
        params.set("faculty", item.name);
      } else {
        params.set("room", item.name);
      }
      const res = await fetch(`${API_BASE}/schedule?${params.toString()}`);
      const entries = (await res.json()) as ScheduleEntry[];
      const titlePrefix =
        category === "faculty" ? "FACULTY" : category === "section" ? "SECTION" : "ROOM";
      const titleColor =
        category === "faculty"
          ? customizeSettings.facultyColors[item.name]
          : undefined;
      setExportProgress({
        current: index + 1,
        total,
        label: `${titlePrefix}: ${item.name}`,
        running: true,
      });
      setExportRender({
        title: `${titlePrefix}: ${item.name}`,
        entries,
        mode,
        selectionName: item.name,
        titleColor,
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const dataUrl = await captureElementToPng(exportRenderRef.current);
      if (exportCancelRef.current) break;
      await fetch(`${API_BASE}/export/png`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          name: sanitizedName,
          png_base64: dataUrl,
        }),
      });
    }
    setExportRender(null);
    setExportProgress(null);
    setIsExporting(false);
    setExportCancelRequested(false);
  };

  const ensureEntityExists = async (path: string, name: string, entities: NamedEntity[]) => {
    if (!name.trim()) return;
    const exists = entities.some(
      (entity) => entity.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (exists) return;
    await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
  };

  const handleCreateSchedule = async () => {
    if (isSaving) return;
    if (formEditId !== null) {
      await saveFormEdit();
      return;
    }
    const timeValue = scheduleForm["Time (LPU Std)"].trim();
    const daysValue = scheduleForm.Days.trim();
    const isTbaEntry =
      !timeValue ||
      timeValue.toLowerCase() === "tba" ||
      !daysValue ||
      daysValue.toLowerCase() === "tba";
    if (!isTbaEntry && scheduleForm["Time (LPU Std)"]) {
      const parsed = parseLpuRange(scheduleForm["Time (LPU Std)"]);
      if (!parsed) {
        setFormError("Invalid Time (LPU Std). Example: 10:00a-12:00p");
        return;
      }
    }
    const requiredFields: Array<keyof ScheduleEntry> = [
      "Section",
      "Course Code",
      "Room",
      "Faculty",
    ];
    const normalizedDays = isTbaEntry ? "TBA" : normalizeDays(scheduleForm.Days);
    if (!isTbaEntry && !normalizedDays) {
      setFormError("Invalid Days. Example: M,W,F");
      return;
    }
    const missing = requiredFields.filter((field) => !scheduleForm[field]);
    if (!isTbaEntry && !scheduleForm["Time (LPU Std)"]) {
      missing.push("Time (LPU Std)");
    }
    if (missing.length > 0) {
      setFormError(`Missing required fields: ${missing.join(", ")}`);
      return;
    }
    setFormError("");
    setIsSaving(true);
    await ensureEntityExists("sections", scheduleForm.Section, sections);
    await ensureEntityExists("faculty", scheduleForm.Faculty, faculty);
    await ensureEntityExists("rooms", scheduleForm.Room, rooms);

    const payload = {
      ...scheduleForm,
      Days: normalizedDays,
      "Time (LPU Std)": isTbaEntry ? "TBA" : scheduleForm["Time (LPU Std)"],
      "Time (24 Hrs)": "",
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
      Units: 0,
      "# of Hours": 0,
      "Time (LPU Std)": "",
      "Time (24 Hrs)": "",
      Days: "",
      Room: "",
      Faculty: "",
    }));
    setLastSelection(null);
    setSelection(null);
    setSelectionEnd(null);
    setSelectionOrigin(null);
    setMoveSnapshot(null);
    setToast({ message: "Saved", showRevert: false });
    await refreshAll();
    setIsSaving(false);
  };

  const handleEdit = (entry: ScheduleEntry) => {
    setEditEntryId(entry.id);
    setEditEntry({ ...entry });
    setEditError("");
  };

  const handleCancelEdit = () => {
    setEditEntryId(null);
    setEditEntry(null);
    setEditError("");
  };

  const handleSaveEdit = async () => {
    if (!editEntry || editEntryId === null) return;
    const timeValue = editEntry["Time (LPU Std)"].trim();
    const daysValue = editEntry.Days.trim();
    const isTbaEntry =
      !timeValue ||
      timeValue.toLowerCase() === "tba" ||
      !daysValue ||
      daysValue.toLowerCase() === "tba";
    if (!isTbaEntry && editEntry["Time (LPU Std)"]) {
      const parsed = parseLpuRange(editEntry["Time (LPU Std)"]);
      if (!parsed) {
        setEditError("Invalid Time (LPU Std). Example: 10:00a-12:00p");
        return;
      }
    }
    const normalizedDays = isTbaEntry ? "TBA" : normalizeDays(editEntry.Days);
    if (!isTbaEntry && !normalizedDays) {
      setEditError("Invalid Days. Example: M,W,F");
      return;
    }
    const payload = {
      ...editEntry,
      Days: normalizedDays,
      "Time (LPU Std)": isTbaEntry ? "TBA" : editEntry["Time (LPU Std)"],
      "Time (24 Hrs)": "",
    };
    await fetch(`${API_BASE}/schedule/${editEntryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    setSelection(null);
    setSelectionEnd(null);
    setContextMenu(null);
    setSelectionOrigin(null);
    setSelectedSection("");
    setSelectedFaculty("");
    setSelectedRoom("");
    setTimetableEntries([]);
    setLastSelection(null);
    setSelectionEnd(null);
    setSelectionOrigin(null);
    setMoveSnapshot(null);
    setToast(null);
    setFormEditId(null);
    setScheduleForm({
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

  const handleImportCsvPreview = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/file/import-csv?preview=true`, {
      method: "POST",
      body: form,
    });
    const summary = (await res.json()) as CsvImportSummary;
    setCsvImportState({ file, summary });
    setCsvInputKey((prev) => prev + 1);
    setOpenMenu(null);
  };

  const handleConfirmCsvImport = async () => {
    if (!csvImportState || isCsvImporting) return;
    setIsCsvImporting(true);
    const form = new FormData();
    form.append("file", csvImportState.file);
    await fetch(`${API_BASE}/file/import-csv?replace=true`, {
      method: "POST",
      body: form,
    });
    setCsvImportState(null);
    setIsCsvImporting(false);
    refreshAll();
  };

  const handleCancelCsvImport = () => {
    setCsvImportState(null);
  };

  const handleCustomizeToggle = () => {
    setOpenMenu(null);
    setIsCustomizeOpen(true);
  };

  const updateBlockDisplay = (key: keyof CustomizeSettings["blockDisplay"], value: boolean) => {
    setCustomizeSettings((prev) => ({
      ...prev,
      blockDisplay: {
        ...prev.blockDisplay,
        [key]: value,
      },
    }));
  };

  const handleSaveFacultyColor = () => {
    const normalized = normalizeHex(facultyColorInput);
    if (!selectedFacultyColor || !normalized) return;
    setCustomizeSettings((prev) => ({
      ...prev,
      facultyColors: {
        ...prev.facultyColors,
        [selectedFacultyColor]: normalized,
      },
    }));
  };

  const handleClearFacultyColor = () => {
    if (!selectedFacultyColor) return;
    setCustomizeSettings((prev) => {
      const next = { ...prev.facultyColors };
      delete next[selectedFacultyColor];
      return { ...prev, facultyColors: next };
    });
  };

  const handleSaveSectionColor = () => {
    const normalized = normalizeHex(sectionColorInput);
    if (!selectedSectionColor || !normalized) return;
    setCustomizeSettings((prev) => ({
      ...prev,
      sectionBgColors: {
        ...prev.sectionBgColors,
        [selectedSectionColor]: normalized,
      },
    }));
  };

  const handleClearSectionColor = () => {
    if (!selectedSectionColor) return;
    setCustomizeSettings((prev) => {
      const next = { ...prev.sectionBgColors };
      delete next[selectedSectionColor];
      return { ...prev, sectionBgColors: next };
    });
  };

  const handleAutoAssignFacultyColors = () => {
    if (facultyOptions.length === 0) return;
    const colors: Record<string, string> = {};
    facultyOptions.forEach((item) => {
      const hue = hashString(item.name);
      const saturation = 65;
      const lightness = 55;
      colors[item.name] = hslToHex(hue, saturation, lightness);
    });
    setCustomizeSettings((prev) => ({
      ...prev,
      blockDisplay: { ...prev.blockDisplay, useFacultyColors: true },
      facultyColors: colors,
    }));
  };

  const handleCancelExport = () => {
    exportCancelRef.current = true;
    setExportCancelRequested(true);
  };

  const handleFacultyRgbChange = (channel: "r" | "g" | "b", value: number) => {
    const next = { ...facultyRgb, [channel]: value };
    setFacultyRgb(next);
    setFacultyColorInput(rgbToHex(next.r, next.g, next.b));
  };

  const handleSectionRgbChange = (channel: "r" | "g" | "b", value: number) => {
    const next = { ...sectionRgb, [channel]: value };
    setSectionRgb(next);
    setSectionColorInput(rgbToHex(next.r, next.g, next.b));
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

  const timetableGroup = viewMode.startsWith("timetable")
    ? viewMode.split("-")[1]
    : "section";

  const isTimetableView = viewMode.startsWith("timetable");
  const effectiveSelection =
    currentViewConfig.selected || currentViewConfig.entities[0]?.name || "";
  const canExportTimetable =
    isTimetableView && Boolean(effectiveSelection) && currentViewConfig.entities.length > 0;
  const currentSectionBg =
    viewMode === "timetable-section"
      ? customizeSettings.sectionBgColors[effectiveSelection]
      : undefined;
  const facultyPickerValue = normalizeHex(facultyColorInput) || colorPalette[0];
  const sectionPickerValue = normalizeHex(sectionColorInput) || colorPalette[0];

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
        if (!entryTime || !otherTime) return null;
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

  const zoomStep = 5;
  const zoomMin = 75;
  const zoomMax = 130;
  const applyZoom = (next: number) => {
    const clamped = Math.min(zoomMax, Math.max(zoomMin, next));
    setZoomPercent(clamped);
    localStorage.setItem("timetableZoom", String(clamped));
  };

  const rowHeight = `${40 * (zoomPercent / 100)}px`;
  const fontSize = `${12 * (zoomPercent / 100)}px`;
  const blockPadding = `${6 * (zoomPercent / 100)}px`;

  const currentIndex = useMemo(
    () =>
      currentViewConfig.entities.findIndex((entity) => entity.name === effectiveSelection),
    [currentViewConfig, effectiveSelection]
  );
  const hasMultipleEntities = currentViewConfig.entities.length > 1;

  const handlePrevEntity = () => {
    if (!hasMultipleEntities) return;
    const nextIndex =
      currentIndex <= 0 ? currentViewConfig.entities.length - 1 : currentIndex - 1;
    currentViewConfig.setSelected(currentViewConfig.entities[nextIndex].name);
  };

  const handleNextEntity = () => {
    if (!hasMultipleEntities) return;
    const nextIndex =
      currentIndex >= currentViewConfig.entities.length - 1 ? 0 : currentIndex + 1;
    currentViewConfig.setSelected(currentViewConfig.entities[nextIndex].name);
  };

  const renderExportGrid = () => {
    if (!exportRender) return null;
    const exportDays = showSunday ? daysOfWeek : daysOfWeek.filter((day) => day !== "Su");
    const exportSectionBg =
      exportRender.mode === "timetable-section"
        ? customizeSettings.sectionBgColors[exportRender.selectionName]
        : undefined;
    return (
      <div className="export-wrapper" style={{ backgroundColor: exportSectionBg }}>
        <div className="export-title" style={{ color: exportRender.titleColor }}>
          {exportRender.title}
        </div>
        <div
          className="timetable-grid export-grid"
          style={{
            gridTemplateColumns: `120px repeat(${exportDays.length}, 1fr)`,
            gridTemplateRows: `repeat(${slots.length}, var(--row-height))`,
            ["--row-height" as string]: rowHeight,
            ["--font-size" as string]: fontSize,
            ["--block-padding" as string]: blockPadding,
          }}
        >
          <div
            className="day-headers"
            style={{ gridTemplateColumns: `120px repeat(${exportDays.length}, 1fr)` }}
          >
            <div className="time-header">Time</div>
            {exportDays.map((day) => (
              <div key={day} className="day-header">
                {dayLabels[day]}
              </div>
            ))}
          </div>
          {slots.map((slot, rowIndex) => (
            <div key={`export-time-${slot}`} className="time-cell" style={{ gridRow: rowIndex + 1 }}>
              {toLpuLabel(slot, slot + interval)}
            </div>
          ))}
          {exportDays.map((day, dayIndex) =>
            slots.map((slot, rowIndex) => (
              <div
                key={`export-${day}-${slot}`}
                className="cell"
                style={{ gridColumn: dayIndex + 2, gridRow: rowIndex + 1 }}
              />
            ))
          )}
          {exportRender.entries.flatMap((entry) => {
            const days = normalizeDays(entry.Days).split(",").filter(Boolean);
            const parsedTime = parseTimeRange(entry["Time (24 Hrs)"]);
            if (!parsedTime || days.length === 0) return [];
            const { start, end } = parsedTime;
            const startIndex = Math.max(0, slots.findIndex((slot) => slot >= start));
            const endIndex = Math.max(startIndex + 1, slots.findIndex((slot) => slot >= end));
            return days
              .filter((day) => exportDays.includes(day))
              .map((day) => {
                const column = exportDays.indexOf(day) + 2;
                const blockBg =
                  !conflictSet.has(entry.id) &&
                  customizeSettings.blockDisplay.useFacultyColors &&
                  customizeSettings.facultyColors[entry.Faculty]
                    ? customizeSettings.facultyColors[entry.Faculty]
                    : undefined;
                const textColor = blockBg ? getReadableTextColor(blockBg) : undefined;
                return (
                  <div
                    key={`export-${entry.id}-${day}`}
                    className={`block ${conflictSet.has(entry.id) ? "conflict" : ""}`}
                    style={{
                      gridColumn: column,
                      gridRow: `${startIndex + 1} / ${Math.max(endIndex, startIndex + 1) + 1}`,
                      backgroundColor: blockBg,
                      color: textColor,
                    }}
                  >
                    <div className="block-content">
                      {customizeSettings.blockDisplay.showCourseCode && (
                        <div className="block-title">{entry["Course Code"]}</div>
                      )}
                      {exportRender.mode !== "timetable-section" && <div>{entry.Section}</div>}
                      {customizeSettings.blockDisplay.showFaculty &&
                        exportRender.mode !== "timetable-faculty" && <div>{entry.Faculty}</div>}
                      {customizeSettings.blockDisplay.showRoom &&
                        exportRender.mode !== "timetable-room" && <div>{entry.Room}</div>}
                    </div>
                  </div>
                );
              });
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-left" ref={menuRef}>
          <div className="menu-bar">
            <div className="menu-group">
              <button
                className={`menu-button ${openMenu === "file" ? "active" : ""}`}
                onClick={() => setOpenMenu((prev) => (prev === "file" ? null : "file"))}
                type="button"
              >
                File ▼
              </button>
              {openMenu === "file" ? (
                <div className="menu-dropdown" role="menu">
                  <button
                    className="menu-item"
                    onClick={() => {
                      handleReset();
                      setOpenMenu(null);
                    }}
                    type="button"
                  >
                    New Timetable
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      handleExportDb();
                      setOpenMenu(null);
                    }}
                    type="button"
                  >
                    Save
                  </button>
                  <label className="menu-item file-input">
                    Open Timetable
                    <input
                      type="file"
                      onChange={(event) => {
                        handleImportDb(event);
                        setOpenMenu(null);
                      }}
                    />
                  </label>
                  <label className="menu-item file-input">
                    Import CSV
                    <input
                      key={csvInputKey}
                      type="file"
                      accept=".csv"
                      onChange={handleImportCsvPreview}
                    />
                  </label>
                </div>
              ) : null}
            </div>
            <div className="menu-group">
              <button
                className={`menu-button ${openMenu === "export" ? "active" : ""}`}
                onClick={() => setOpenMenu((prev) => (prev === "export" ? null : "export"))}
                type="button"
              >
                Export ▼
              </button>
              {openMenu === "export" ? (
                <div className="menu-dropdown" role="menu">
                  <button
                    className="menu-item"
                    onClick={() => {
                      handleExport("/reports/text.csv", "text-view.csv");
                      setOpenMenu(null);
                    }}
                    type="button"
                  >
                    Export Text View (CSV)
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      exportTimetablePng();
                      setOpenMenu(null);
                    }}
                    disabled={!canExportTimetable || isExporting}
                    type="button"
                  >
                    Export Timetable (Current View)
                  </button>
                  <div className="menu-divider" />
                  <button
                    className="menu-item submenu-trigger"
                    type="button"
                    onClick={() => setOpenExportSubmenu((prev) => !prev)}
                    disabled={isExporting}
                  >
                    Mass Export Timetables ▸
                  </button>
                  {openExportSubmenu ? (
                    <div className="submenu">
                      <button
                        className="menu-item"
                        type="button"
                        disabled={isExporting}
                        onClick={() => {
                          setOpenMenu(null);
                          setOpenExportSubmenu(false);
                          exportBatch("faculty", facultyOptions);
                        }}
                      >
                        By Faculty
                      </button>
                      <button
                        className="menu-item"
                        type="button"
                        disabled={isExporting}
                        onClick={() => {
                          setOpenMenu(null);
                          setOpenExportSubmenu(false);
                          exportBatch("section", sectionOptions);
                        }}
                      >
                        By Section
                      </button>
                      <button
                        className="menu-item"
                        type="button"
                        disabled={isExporting}
                        onClick={() => {
                          setOpenMenu(null);
                          setOpenExportSubmenu(false);
                          exportBatch("room", roomOptions);
                        }}
                      >
                        By Room
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="menu-group">
              <button
                className={`menu-button ${openMenu === "rules" ? "active" : ""}`}
                onClick={() => setOpenMenu((prev) => (prev === "rules" ? null : "rules"))}
                type="button"
              >
                Rules ▼
              </button>
              {openMenu === "rules" ? (
                <div className="menu-dropdown rules-dropdown" role="menu">
                  <label className="menu-checkbox">
                    <input
                      type="checkbox"
                      checked={ignoreFaculty}
                      onChange={(event) => setIgnoreFaculty(event.target.checked)}
                    />
                    Ignore faculty conflicts
                  </label>
                  <label className="menu-checkbox">
                    <input
                      type="checkbox"
                      checked={ignoreRoom}
                      onChange={(event) => setIgnoreRoom(event.target.checked)}
                    />
                    Ignore room conflicts
                  </label>
                  <label className="menu-checkbox">
                    <input
                      type="checkbox"
                      checked={ignoreTba}
                      onChange={(event) => setIgnoreTba(event.target.checked)}
                    />
                    Ignore TBA time/day
                  </label>
                  <div className="menu-divider" />
                  <button
                    className="menu-item"
                    onClick={() => setShowFacultyRules((prev) => !prev)}
                    type="button"
                  >
                    {showFacultyRules ? "Hide" : "Manage"} Faculty Ignore List…
                  </button>
                  {showFacultyRules ? (
                    <div className="rule-section compact">
                      <div className="rule-input">
                        <input
                          value={facultyInput}
                          onChange={(event) => setFacultyInput(event.target.value)}
                          placeholder="Faculty name"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!facultyInput.trim()) return;
                            setIgnoreFacultyList((prev) => [...prev, facultyInput.trim()]);
                            setFacultyInput("");
                          }}
                        >
                          Add
                        </button>
                      </div>
                      <label className="menu-checkbox">
                        <input
                          type="checkbox"
                          checked={containsFaculty}
                          onChange={(event) => setContainsFaculty(event.target.checked)}
                        />
                        Contains match
                      </label>
                      <div className="chips">
                        {ignoreFacultyList.map((item) => (
                          <span key={item} className="chip">
                            {item}
                            <button
                              type="button"
                              onClick={() =>
                                setIgnoreFacultyList((prev) =>
                                  prev.filter((value) => value !== item)
                                )
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <button
                    className="menu-item"
                    onClick={() => setShowRoomRules((prev) => !prev)}
                    type="button"
                  >
                    {showRoomRules ? "Hide" : "Manage"} Room Ignore List…
                  </button>
                  {showRoomRules ? (
                    <div className="rule-section compact">
                      <div className="rule-input">
                        <input
                          value={roomInput}
                          onChange={(event) => setRoomInput(event.target.value)}
                          placeholder="Room name"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!roomInput.trim()) return;
                            setIgnoreRoomList((prev) => [...prev, roomInput.trim()]);
                            setRoomInput("");
                          }}
                        >
                          Add
                        </button>
                      </div>
                      <label className="menu-checkbox">
                        <input
                          type="checkbox"
                          checked={containsRoom}
                          onChange={(event) => setContainsRoom(event.target.checked)}
                        />
                        Contains match
                      </label>
                      <div className="chips">
                        {ignoreRoomList.map((item) => (
                          <span key={item} className="chip">
                            {item}
                            <button
                              type="button"
                              onClick={() =>
                                setIgnoreRoomList((prev) => prev.filter((value) => value !== item))
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="menu-group">
              <button className="menu-button" onClick={handleCustomizeToggle} type="button">
                Customize ▼
              </button>
            </div>
          </div>
          <div className="view-buttons">
            <button
              className={viewMode === "text" ? "active" : ""}
              onClick={() => setViewMode("text")}
              type="button"
            >
              Text View
            </button>
            <button
              className={viewMode === "timetable-section" ? "active" : ""}
              onClick={() => setViewMode("timetable-section")}
              type="button"
            >
              Timetable: Per Section
            </button>
            <button
              className={viewMode === "timetable-faculty" ? "active" : ""}
              onClick={() => setViewMode("timetable-faculty")}
              type="button"
            >
              Timetable: Per Faculty
            </button>
            <button
              className={viewMode === "timetable-room" ? "active" : ""}
              onClick={() => setViewMode("timetable-room")}
              type="button"
            >
              Timetable: Per Room
            </button>
          </div>
        </div>
        <div className="ribbon-conflicts">
          <div className="ribbon-title">Conflicts</div>
          {conflictDetails.length === 0 ? (
            <p className="muted">No conflicts detected.</p>
          ) : (
            <ul className="conflict-list">
                  {conflictDetails.map((conflict, index) => (
                    <li key={`${conflict?.entry.id}-${conflict?.other.id}-${index}`}>
                      <strong>{conflict?.type.toUpperCase()}</strong>:{" "}
                      {conflict?.entry["Course Code"]} ({conflict?.entry.Section}) vs{" "}
                      {conflict?.other["Course Code"]} ({conflict?.other.Section}) on{" "}
                      {conflict ? normalizeDays(conflict.sharedDays.join(",")) : ""} at{" "}
                      {conflict?.overlapTime}
                    </li>
                  ))}
            </ul>
          )}
        </div>
      </div>
      <div id="export-render-root" className="export-render-root" ref={exportRenderRef}>
        {exportRender ? renderExportGrid() : null}
      </div>
      {exportProgress ? (
        <div className="export-progress toast overlay">
          <span>
            Exporting {exportProgress.current} / {exportProgress.total} —{" "}
            {exportProgress.label}
          </span>
          <button className="nav-button" onClick={handleCancelExport}>
            Cancel
          </button>
        </div>
      ) : null}
      {csvImportState ? (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Import CSV</h3>
            <p>
              Rows detected: <strong>{csvImportState.summary.rows_total}</strong>
            </p>
            {csvImportState.summary.missing_columns.length > 0 ? (
              <div className="modal-warning">
                Missing required columns:{" "}
                {csvImportState.summary.missing_columns.join(", ")}
              </div>
            ) : null}
            {csvImportState.summary.errors.length > 0 ? (
              <div className="modal-errors">
                <div>
                  Rows with errors: {csvImportState.summary.errors.length}
                </div>
                <ul>
                  {csvImportState.summary.errors.slice(0, 5).map((error) => (
                    <li key={`${error.row_index}-${error.reason}`}>
                      Row {error.row_index}: {error.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>Replace current timetable with this CSV?</p>
            <div className="modal-actions">
              <button type="button" onClick={handleCancelCsvImport}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCsvImport}
                disabled={
                  isCsvImporting || csvImportState.summary.missing_columns.length > 0
                }
              >
                {isCsvImporting ? "Importing..." : "Yes, Replace"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isCustomizeOpen ? (
        <div className="modal-overlay">
          <div className="modal modal-wide" ref={customizeModalRef}>
            <div className="modal-header">
              <h3>Customize Timetable</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setIsCustomizeOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-section">
              <h4>Block Layout</h4>
              <label className="menu-checkbox">
                <input
                  type="checkbox"
                  checked={customizeSettings.blockDisplay.showCourseCode}
                  onChange={(event) =>
                    updateBlockDisplay("showCourseCode", event.target.checked)
                  }
                />
                Show Course Code
              </label>
              <label className="menu-checkbox">
                <input
                  type="checkbox"
                  checked={customizeSettings.blockDisplay.showRoom}
                  onChange={(event) => updateBlockDisplay("showRoom", event.target.checked)}
                />
                Show Room
              </label>
              <label className="menu-checkbox">
                <input
                  type="checkbox"
                  checked={customizeSettings.blockDisplay.showFaculty}
                  onChange={(event) =>
                    updateBlockDisplay("showFaculty", event.target.checked)
                  }
                />
                Show Faculty name
              </label>
              <label className="menu-checkbox">
                <input
                  type="checkbox"
                  checked={customizeSettings.blockDisplay.useFacultyColors}
                  onChange={(event) =>
                    updateBlockDisplay("useFacultyColors", event.target.checked)
                  }
                />
                Use faculty colors for class blocks
              </label>
            </div>
            <div className="modal-section">
              <h4>Faculty Colors</h4>
              <div className="modal-row">
                <select
                  value={selectedFacultyColor}
                  onChange={(event) => setSelectedFacultyColor(event.target.value)}
                >
                  {facultyOptions.map((item) => (
                    <option key={item.id} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <div className="color-input">
                  <input
                    type="color"
                    value={facultyPickerValue}
                    onChange={(event) => setFacultyColorInput(event.target.value)}
                  />
                  <input
                    className="hex-input"
                    value={facultyColorInput}
                    onChange={(event) => setFacultyColorInput(event.target.value)}
                    placeholder="#RRGGBB"
                  />
                </div>
              </div>
              <div className="palette-row">
                {colorPalette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="palette-swatch"
                    style={{ backgroundColor: color }}
                    onClick={() => setFacultyColorInput(color)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="advanced-toggle"
                onClick={() => setShowFacultyAdvanced((prev) => !prev)}
              >
                {showFacultyAdvanced ? "Hide advanced controls" : "Show advanced controls"}
              </button>
              {showFacultyAdvanced ? (
                <div className="advanced-controls">
                  <label>
                    Red
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={facultyRgb.r}
                      onChange={(event) =>
                        handleFacultyRgbChange("r", Number(event.target.value))
                      }
                    />
                    <span>{facultyRgb.r}</span>
                  </label>
                  <label>
                    Green
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={facultyRgb.g}
                      onChange={(event) =>
                        handleFacultyRgbChange("g", Number(event.target.value))
                      }
                    />
                    <span>{facultyRgb.g}</span>
                  </label>
                  <label>
                    Blue
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={facultyRgb.b}
                      onChange={(event) =>
                        handleFacultyRgbChange("b", Number(event.target.value))
                      }
                    />
                    <span>{facultyRgb.b}</span>
                  </label>
                </div>
              ) : null}
              <div className="modal-actions">
                <button type="button" onClick={handleSaveFacultyColor}>
                  Save Color
                </button>
                <button type="button" onClick={handleClearFacultyColor}>
                  Clear Color
                </button>
                <button type="button" onClick={handleAutoAssignFacultyColors}>
                  Auto-assign colors for all faculty
                </button>
              </div>
            </div>
            <div className="modal-section">
              <h4>Section Background</h4>
              <div className="modal-row">
                <select
                  value={selectedSectionColor}
                  onChange={(event) => setSelectedSectionColor(event.target.value)}
                >
                  {sectionOptions.map((item) => (
                    <option key={item.id} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <div className="color-input">
                  <input
                    type="color"
                    value={sectionPickerValue}
                    onChange={(event) => setSectionColorInput(event.target.value)}
                  />
                  <input
                    className="hex-input"
                    value={sectionColorInput}
                    onChange={(event) => setSectionColorInput(event.target.value)}
                    placeholder="#RRGGBB"
                  />
                </div>
              </div>
              <div className="palette-row">
                {colorPalette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="palette-swatch"
                    style={{ backgroundColor: color }}
                    onClick={() => setSectionColorInput(color)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="advanced-toggle"
                onClick={() => setShowSectionAdvanced((prev) => !prev)}
              >
                {showSectionAdvanced ? "Hide advanced controls" : "Show advanced controls"}
              </button>
              {showSectionAdvanced ? (
                <div className="advanced-controls">
                  <label>
                    Red
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={sectionRgb.r}
                      onChange={(event) =>
                        handleSectionRgbChange("r", Number(event.target.value))
                      }
                    />
                    <span>{sectionRgb.r}</span>
                  </label>
                  <label>
                    Green
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={sectionRgb.g}
                      onChange={(event) =>
                        handleSectionRgbChange("g", Number(event.target.value))
                      }
                    />
                    <span>{sectionRgb.g}</span>
                  </label>
                  <label>
                    Blue
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={sectionRgb.b}
                      onChange={(event) =>
                        handleSectionRgbChange("b", Number(event.target.value))
                      }
                    />
                    <span>{sectionRgb.b}</span>
                  </label>
                </div>
              ) : null}
              <div className="modal-actions">
                <button type="button" onClick={handleSaveSectionColor}>
                  Save Background
                </button>
                <button type="button" onClick={handleClearSectionColor}>
                  Clear Background
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
                              value={
                                header === "Time (24 Hrs)"
                                  ? editEntry["Time (24 Hrs)"] ?? ""
                                  : String(editEntry[header])
                              }
                              readOnly={header === "Time (24 Hrs)"}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (header === "Time (LPU Std)") {
                                  const parsed = parseLpuRange(value);
                                  const isTbaValue =
                                    value.trim().toLowerCase() === "tba" || value.trim() === "";
                                  setEditEntry({
                                    ...editEntry,
                                    "Time (LPU Std)": value,
                                    "Time (24 Hrs)": parsed
                                      ? parsed.time24
                                      : isTbaValue
                                        ? ""
                                        : editEntry["Time (24 Hrs)"],
                                  });
                                  setEditError(
                                    value && !parsed && !isTbaValue
                                      ? "Invalid Time (LPU Std). Example: 10:00a-12:00p"
                                      : ""
                                  );
                                  return;
                                }
                                setEditEntry({
                                  ...editEntry,
                                  [header]:
                                    header === "Units" || header === "# of Hours"
                                      ? Number(value)
                                      : value,
                                } as ScheduleEntry);
                              }}
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
              {editError && <p className="error">{editError}</p>}
            </div>
          ) : (
            <div
              className="timetable"
              onContextMenu={handleContextMenu}
              onMouseUp={finalizeSelection}
              ref={timetableRef}
              style={
                currentSectionBg
                  ? {
                      backgroundColor: currentSectionBg,
                    }
                  : undefined
              }
            >
              <div className="timetable-header">
                <div className="timetable-header-left">
                  <button
                    className="nav-button"
                    onClick={handlePrevEntity}
                    disabled={!hasMultipleEntities}
                  >
                    ◀
                  </button>
                  <select
                    value={effectiveSelection}
                    onChange={(event) => currentViewConfig.setSelected(event.target.value)}
                    disabled={currentViewConfig.entities.length === 0}
                  >
                    {currentViewConfig.entities.map((entity) => (
                      <option key={entity.id} value={entity.name}>
                        {entity.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="timetable-title">
                  {effectiveSelection ||
                    (currentViewConfig.label ? `No ${currentViewConfig.label} yet` : "")}
                </div>
                <div className="timetable-header-right">
                  <div className="zoom-controls">
                    <button
                      className="nav-button"
                      onClick={() => applyZoom(zoomPercent - zoomStep)}
                      disabled={zoomPercent <= zoomMin}
                    >
                      -
                    </button>
                    <button className="nav-button" onClick={() => applyZoom(100)}>
                      Reset
                    </button>
                    <button
                      className="nav-button"
                      onClick={() => applyZoom(zoomPercent + zoomStep)}
                      disabled={zoomPercent >= zoomMax}
                    >
                      +
                    </button>
                  </div>
                  <button
                    className="nav-button"
                    onClick={handleNextEntity}
                    disabled={!hasMultipleEntities}
                  >
                    ▶
                  </button>
                </div>
              </div>
              {toast && (
                <div className="toast overlay">
                  <span>{toast.message}</span>
                  {toast.showRevert && moveSnapshot && (
                    <button className="nav-button" onClick={handleRevertMove}>
                      Revert
                    </button>
                  )}
                </div>
              )}
              {currentViewConfig.entities.length === 0 ? (
                <p className="timetable-empty">No {currentViewConfig.label} yet.</p>
              ) : (
                <>
                  <div
                    className="day-headers"
                    style={{
                      gridTemplateColumns: `120px repeat(${visibleDays.length}, 1fr)`,
                    }}
                  >
                    <div className="time-header">Time</div>
                    {visibleDays.map((day) => (
                      <div key={day} className="day-header">
                        {dayLabels[day]}
                      </div>
                    ))}
                  </div>
                  <div
                    className="timetable-grid"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      handleDrop();
                    }}
                    style={{
                      gridTemplateColumns: `120px repeat(${visibleDays.length}, 1fr)`,
                      gridTemplateRows: `repeat(${slots.length}, var(--row-height))`,
                      ["--row-height" as string]: rowHeight,
                      ["--font-size" as string]: fontSize,
                      ["--block-padding" as string]: blockPadding,
                    }}
                  >
                    {slots.map((slot, rowIndex) => (
                      <div
                        key={`time-${slot}`}
                        className="time-cell"
                        style={{ gridRow: rowIndex + 1 }}
                      >
                        {toLpuLabel(slot, slot + interval)}
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
                          onMouseDown={(event) => handleSelectStart(event, day, rowIndex)}
                          onMouseEnter={() => handleSelectMove(day, rowIndex)}
                          onMouseUp={finalizeSelection}
                          onDragOver={(event) => handleDragOver(event, day, slot)}
                          data-day={day}
                          data-slot={slot}
                        />
                      ))
                    )}
                    {timetableEntries.flatMap((entry) => {
                      const days = normalizeDays(entry.Days).split(",").filter(Boolean);
                      const parsedTime = parseTimeRange(entry["Time (24 Hrs)"]);
                      if (!parsedTime || days.length === 0) return [];
                      const { start, end } = parsedTime;
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
                          const blockBg =
                            !conflictSet.has(entry.id) &&
                            customizeSettings.blockDisplay.useFacultyColors &&
                            customizeSettings.facultyColors[entry.Faculty]
                              ? customizeSettings.facultyColors[entry.Faculty]
                              : undefined;
                          const textColor = blockBg ? getReadableTextColor(blockBg) : undefined;
                          return (
                            <div
                              key={`${entry.id}-${day}`}
                              className={`block ${conflictSet.has(entry.id) ? "conflict" : ""}`}
                              style={{
                                gridColumn: column,
                                gridRow: `${startIndex + 1} / ${Math.max(endIndex, startIndex + 1) + 1}`,
                                backgroundColor: blockBg,
                                color: textColor,
                              }}
                              draggable
                              onDragStart={() => handleDragStart(entry, day)}
                              onDragEnd={() => {
                                setDragging(null);
                                setDragTarget(null);
                              }}
                              onContextMenu={(event) => handleBlockContextMenu(event, entry)}
                            >
                              <div className="block-content">
                                {customizeSettings.blockDisplay.showCourseCode && (
                                  <div className="block-title">{entry["Course Code"]}</div>
                                )}
                                {viewMode !== "timetable-section" && <div>{entry.Section}</div>}
                                {customizeSettings.blockDisplay.showFaculty &&
                                  viewMode !== "timetable-faculty" && <div>{entry.Faculty}</div>}
                                {customizeSettings.blockDisplay.showRoom &&
                                  viewMode !== "timetable-room" && <div>{entry.Room}</div>}
                              </div>
                            </div>
                          );
                        });
                    })}
                    {dragging && dragTarget && (
                      <div
                        className="block preview"
                        style={{
                          gridColumn: visibleDays.indexOf(dragTarget.day) + 2,
                          gridRow: `${Math.max(
                            1,
                            slots.findIndex((slot) => slot >= dragTarget.startMinutes) + 1
                          )} / ${Math.max(
                            1,
                            slots.findIndex((slot) => slot >= dragTarget.startMinutes) +
                              Math.ceil(dragging.duration / interval) +
                              1
                          )}`,
                        }}
                      >
                        <div className="block-title">{dragging.entry["Course Code"]}</div>
                      </div>
                    )}
                  </div>
                </>
              )}
              {contextMenu && (
                <div
                  className="context-menu"
                  style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                  <button onClick={applySelectionToForm}>Add Class</button>
                </div>
              )}
              {blockMenu && (
                <div
                  className="block-menu"
                  style={{ top: blockMenu.y, left: blockMenu.x }}
                >
                  <button onClick={() => enterEditMode(blockMenu.entry)} disabled={isSaving}>
                    Edit
                  </button>
                  <button onClick={() => deleteEntry(blockMenu.entry)} disabled={isSaving}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="panel" ref={panelRef}>
          <h3>Add Class</h3>
          <label>
            Program
            <input
              value={scheduleForm.Program}
              onChange={(event) => {
                const value = event.target.value;
                setScheduleForm({ ...scheduleForm, Program: value });
                localStorage.setItem("lastProgram", value);
              }}
            />
          </label>
          <label>
            Section
            <input
              value={scheduleForm.Section}
              onChange={(event) => {
                const value = event.target.value;
                setScheduleForm({ ...scheduleForm, Section: value });
                localStorage.setItem("lastSection", value);
              }}
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
              ref={courseCodeRef}
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
              onChange={(event) => {
                const value = event.target.value;
                const parsed = parseLpuRange(value);
                const isTbaValue = value.trim().toLowerCase() === "tba" || value.trim() === "";
                setScheduleForm((prev) => ({
                  ...prev,
                  "Time (LPU Std)": value,
                  "Time (24 Hrs)": parsed ? parsed.time24 : isTbaValue ? "" : prev["Time (24 Hrs)"],
                }));
                if (value && !parsed && !isTbaValue) {
                  setFormError("Invalid Time (LPU Std). Example: 10:00a-12:00p");
                } else {
                  setFormError("");
                }
              }}
            />
          </label>
          <label>
            Time (24 Hrs)
            <input
              value={scheduleForm["Time (24 Hrs)"] ?? ""}
              readOnly
            />
          </label>
          <label>
            Days
            <input
              value={scheduleForm.Days}
              onChange={(event) =>
                setScheduleForm({ ...scheduleForm, Days: event.target.value })
              }
              onBlur={(event) => {
                const value = event.target.value;
                const trimmed = value.trim();
                setScheduleForm({
                  ...scheduleForm,
                  Days:
                    trimmed.toLowerCase() === "tba" || trimmed === ""
                      ? "TBA"
                      : normalizeDays(value),
                });
              }}
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
          <button onClick={handleCreateSchedule} disabled={isSaving}>
            {formEditId ? "Save Changes" : "Add Class"}
          </button>
          {formEditId && (
            <button className="secondary-button" onClick={cancelEditMode} disabled={isSaving}>
              Cancel
            </button>
          )}
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
        </aside>
      </div>
    </div>
  );
}
