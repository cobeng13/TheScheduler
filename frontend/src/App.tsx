import html2canvas from "html2canvas";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClassEditor } from "./ClassEditor";
import { TimetablePane } from "./TimetablePane";
import { assignmentForPane, linkedScrollTop, loadPaneSettings, paneField, type PaneId, type PaneState, type TimetableMode } from "./panes";

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

type MoveConflictDetail = {
  conflict_type: "section" | "room" | "faculty";
  entry: ScheduleEntry;
};

type MoveCheckResponse = {
  ok: boolean;
  reason?: string;
  conflicts?: MoveConflictDetail[];
};

type CsvImportSummary = {
  rows_total: number;
  rows_imported: number;
  rows_skipped: number;
  missing_columns: string[];
  errors: Array<{ row_index: number; reason: string }>;
};

type CurriculumTerm = "First Semester" | "Second Semester" | "Term Break";

type CurriculumCourse = {
  program: string;
  yearLevel: string;
  semester: CurriculumTerm;
  courseCode: string;
  courseDescription: string;
  lecUnits: number;
  labUnits: number;
  totalUnits: number;
  hours: number;
};

type Curriculum = {
  id: string;
  name: string;
  sourceFileName: string;
  importedAt: string;
  courses: CurriculumCourse[];
};

type CurriculumState = {
  curricula: Curriculum[];
  selectedTerm: CurriculumTerm;
  sectionYearLevels: Record<string, string>;
  yearLevelCurriculumIds: Record<string, string>;
};

type CourseDescriptionConflict = {
  codeKey: string;
  code: string;
  descriptions: string[];
  entryIdsByDescription: Record<string, number[]>;
};

type ViewMode = "text" | "timetable-section" | "timetable-faculty" | "timetable-room";
type EntityEditorKind = "section" | "faculty" | "room";

type Selection = {
  day: string;
  startIndex: number;
  endIndex: number;
} | null;

type MoveSnapshot = {
  previousEntries: ScheduleEntry[];
  atomic: { before: ScheduleEntry[]; after: ScheduleEntry[]; conflict_settings: Record<string, unknown>; original_conflicts: Array<[number, number, string]>; signature: string };
};

type UndoAction =
  | { type: "add"; entryId: number; label: string }
  | { type: "delete"; entry: ScheduleEntry; label: string }
  | { type: "edit"; entry: ScheduleEntry; label: string }
  | { type: "move"; snapshot: MoveSnapshot; label: string };

type CustomizeSettings = {
  blockDisplay: {
    showCourseCode: boolean;
    showRoom: boolean;
    showFaculty: boolean;
    useFacultyColors: boolean;
  };
  classBlockFontSizePx: number;
  facultyColors: Record<string, string>;
  sectionBgColors: Record<string, string>;
};

type ConflictIgnoreSettings = {
  ignoreFaculty: boolean;
  ignoreRoom: boolean;
  ignoreTba: boolean;
  ignoreFacultyList: string[];
  ignoreRoomList: string[];
  containsFaculty: boolean;
  containsRoom: boolean;
};

const API_BASE = "http://localhost:8000";
const API_FALLBACK_BASE = "http://localhost:8001";
const CUSTOMIZE_STORAGE_KEY = "scheduler.customize";
const CURRICULUM_STORAGE_KEY = "scheduler.curriculum";
const CURRICULUM_STATE_STORAGE_KEY = "scheduler.curriculum.state";
const CURRICULUM_TERM_STORAGE_KEY = "scheduler.curriculum.term";
const CURRICULUM_STORAGE_VERSION_KEY = "scheduler.curriculum.version";
const CURRICULUM_STORAGE_VERSION = "3";
const SECTION_YEAR_LEVELS_STORAGE_KEY = "scheduler.sectionYearLevels";
const LEGACY_RULE_STORAGE_KEYS = [
  "rulesIgnoreFaculty",
  "rulesIgnoreRoom",
  "rulesIgnoreTba",
  "rulesIgnoreFacultyList",
  "rulesIgnoreRoomList",
  "rulesContainsFaculty",
  "rulesContainsRoom",
];

const defaultCurriculumState: CurriculumState = {
  curricula: [],
  selectedTerm: "First Semester",
  sectionYearLevels: {},
  yearLevelCurriculumIds: {},
};

const defaultCustomizeSettings: CustomizeSettings = {
  blockDisplay: {
    showCourseCode: true,
    showRoom: true,
    showFaculty: true,
    useFacultyColors: false,
  },
  classBlockFontSizePx: 12,
  facultyColors: {},
  sectionBgColors: {},
};

const defaultConflictIgnoreSettings: ConflictIgnoreSettings = {
  ignoreFaculty: false,
  ignoreRoom: false,
  ignoreTba: false,
  ignoreFacultyList: [],
  ignoreRoomList: [],
  containsFaculty: false,
  containsRoom: false,
};

const normalizeCustomizeSettings = (settings: Partial<CustomizeSettings> | null) => ({
  ...defaultCustomizeSettings,
  ...settings,
  classBlockFontSizePx:
    settings?.classBlockFontSizePx ?? defaultCustomizeSettings.classBlockFontSizePx,
  blockDisplay: {
    ...defaultCustomizeSettings.blockDisplay,
    ...settings?.blockDisplay,
  },
});

const isCustomizeSettingsShape = (settings: unknown): settings is Partial<CustomizeSettings> => {
  if (!settings || typeof settings !== "object") return false;
  const value = settings as Record<string, unknown>;
  return (
    "blockDisplay" in value ||
    "classBlockFontSizePx" in value ||
    "facultyColors" in value ||
    "sectionBgColors" in value
  );
};

const normalizeStringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];

const normalizeConflictIgnoreSettings = (
  settings: Partial<ConflictIgnoreSettings> | null
): ConflictIgnoreSettings => ({
  ignoreFaculty: settings?.ignoreFaculty ?? defaultConflictIgnoreSettings.ignoreFaculty,
  ignoreRoom: settings?.ignoreRoom ?? defaultConflictIgnoreSettings.ignoreRoom,
  ignoreTba: settings?.ignoreTba ?? defaultConflictIgnoreSettings.ignoreTba,
  ignoreFacultyList: normalizeStringList(settings?.ignoreFacultyList),
  ignoreRoomList: normalizeStringList(settings?.ignoreRoomList),
  containsFaculty: settings?.containsFaculty ?? defaultConflictIgnoreSettings.containsFaculty,
  containsRoom: settings?.containsRoom ?? defaultConflictIgnoreSettings.containsRoom,
});

const normalizeCurriculumState = (
  state: Partial<CurriculumState> | null
): CurriculumState => ({
  curricula: Array.isArray(state?.curricula) ? state.curricula : [],
  selectedTerm: normalizeSemester(state?.selectedTerm ?? "") ?? defaultCurriculumState.selectedTerm,
  sectionYearLevels:
    state?.sectionYearLevels && typeof state.sectionYearLevels === "object"
      ? state.sectionYearLevels
      : {},
  yearLevelCurriculumIds:
    state?.yearLevelCurriculumIds && typeof state.yearLevelCurriculumIds === "object"
      ? state.yearLevelCurriculumIds
      : {},
});

const buildCurriculumId = () =>
  `curriculum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const getFileBaseName = (fileName: string) =>
  fileName.replace(/\.[^/.]+$/, "").trim() || "Curriculum";

const buildEmptyScheduleForm = (defaults?: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: 0,
  "Program": defaults?.Program ?? "",
  "Section": defaults?.Section ?? "",
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

const normalizeMatchValue = (value: string) => value.trim().toLowerCase();
const draftFingerprint = (entry: ScheduleEntry) => JSON.stringify(canonicalHeaders.filter(field => field !== "# of Hours" && field !== "Time (24 Hrs)").map(field => entry[field]));

const roundHours = (value: number) => Number(value.toFixed(2));

const getYearLevelSortRank = (yearLevel: string) => {
  const normalized = normalizeMatchValue(yearLevel);
  const numericPrefix = normalized.match(/^(\d+)/);
  if (numericPrefix) {
    return Number(numericPrefix[1]);
  }
  if (normalized.includes("first")) return 1;
  if (normalized.includes("second")) return 2;
  if (normalized.includes("third")) return 3;
  if (normalized.includes("fourth")) return 4;
  if (normalized.includes("fifth")) return 5;
  return Number.MAX_SAFE_INTEGER;
};

const compareYearLevels = (left: string, right: string) => {
  const leftRank = getYearLevelSortRank(left);
  const rightRank = getYearLevelSortRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
};

const curriculumTerms: CurriculumTerm[] = ["First Semester", "Second Semester", "Term Break"];

const normalizeSemester = (value: string): CurriculumTerm | null => {
  const cleaned = normalizeMatchValue(value);
  if (["1st", "1st sem", "first sem", "first semester"].includes(cleaned)) {
    return "First Semester";
  }
  if (["2nd", "2nd sem", "second sem", "second semester"].includes(cleaned)) {
    return "Second Semester";
  }
  if (["term break", "term-break", "summer", "midyear"].includes(cleaned)) {
    return "Term Break";
  }
  return curriculumTerms.find((term) => normalizeMatchValue(term) === cleaned) ?? null;
};

const calculateCurriculumHours = (
  semester: CurriculumTerm,
  lecUnits: number,
  labUnits: number
) => {
  if (semester === "Term Break") {
    return roundHours(lecUnits * 4.25);
  }
  return roundHours(lecUnits + labUnits * 3);
};

const parseCsvText = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim())) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) {
    rows.push(row);
  }
  return rows;
};

const parseCurriculumCsv = (text: string) => {
  const rows = parseCsvText(text);
  const headers = rows[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  const headerIndex = (name: string) => headers.indexOf(name.toLowerCase());
  const indexes = {
    program: headerIndex("Program"),
    yearLevel: headerIndex("Year Level"),
    semester: headerIndex("Semester"),
    courseCode: headerIndex("Course Code"),
    courseDescription: headerIndex("Course Description"),
    lecLab: headerIndex("Lec/Lab"),
    units: headerIndex("Units"),
  };
  const missingColumns = Object.entries(indexes)
    .filter(([, index]) => index === -1)
    .map(([name]) => name);
  if (missingColumns.length > 0) {
    throw new Error(`Missing curriculum columns: ${missingColumns.join(", ")}`);
  }

  type CurriculumCourseParts = {
    program: string;
    yearLevel: string;
    semester: CurriculumTerm;
    courseCode: string;
    courseDescription: string;
    lecUnits: number;
    labUnits: number;
  };

  const coursesByKey = new Map<string, CurriculumCourseParts>();
  rows.slice(1).forEach((row) => {
    const semester = normalizeSemester(row[indexes.semester] ?? "");
    const courseCode = (row[indexes.courseCode] ?? "").trim();
    const courseDescription = (row[indexes.courseDescription] ?? "").trim();
    if (!semester || !courseCode || !courseDescription) return;
    const lecLab = normalizeMatchValue(row[indexes.lecLab] ?? "");
    const units = Number((row[indexes.units] ?? "").trim());
    const unitValue = Number.isFinite(units) ? units : 0;
    const program = (row[indexes.program] ?? "").trim();
    const yearLevel = (row[indexes.yearLevel] ?? "").trim();
    const key = [
      normalizeMatchValue(program),
      normalizeMatchValue(yearLevel),
      normalizeMatchValue(semester),
      normalizeMatchValue(courseCode),
      normalizeMatchValue(courseDescription),
    ].join("|");
    const existing =
      coursesByKey.get(key) ??
      {
        program,
        yearLevel,
        semester,
        courseCode,
        courseDescription,
        lecUnits: 0,
        labUnits: 0,
      };
    if (lecLab.includes("lab")) {
      existing.labUnits += unitValue;
    } else {
      existing.lecUnits += unitValue;
    }
    coursesByKey.set(key, existing);
  });

  const courses = [...coursesByKey.values()].flatMap((course) => {
    const hasLec = course.lecUnits > 0;
    const hasLab = course.labUnits > 0;
    const hasBoth = hasLec && hasLab;
    const entries: CurriculumCourse[] = [];

    if (hasLec) {
      entries.push({
        ...course,
        courseCode: hasBoth ? `${course.courseCode} LEC` : course.courseCode,
        courseDescription: hasBoth
          ? `${course.courseDescription} LEC`
          : course.courseDescription,
        lecUnits: course.lecUnits,
        labUnits: 0,
        totalUnits: roundHours(course.lecUnits),
        hours: calculateCurriculumHours(course.semester, course.lecUnits, 0),
      });
    }

    if (hasLab) {
      entries.push({
        ...course,
        courseCode: `${course.courseCode} LAB`,
        courseDescription: `${course.courseDescription} LAB`,
        lecUnits: 0,
        labUnits: course.labUnits,
        totalUnits: roundHours(course.labUnits),
        hours: calculateCurriculumHours(course.semester, 0, course.labUnits),
      });
    }

    return entries;
  });

  return courses.sort((left, right) =>
    left.courseCode.localeCompare(right.courseCode, undefined, { sensitivity: "base" })
  );
};

const getEntryWeeklyHours = (entry: ScheduleEntry) => {
  const parsed24 = parseTimeRange(entry["Time (24 Hrs)"]);
  const parsedLpu = parseLpuRange(entry["Time (LPU Std)"]);
  const startMinutes = parsed24?.start ?? parsedLpu?.startMinutes;
  const endMinutes = parsed24?.end ?? parsedLpu?.endMinutes;
  const dayCount = splitDays(entry.Days).length;
  if (startMinutes === undefined || endMinutes === undefined || dayCount === 0) {
    return 0;
  }
  return ((endMinutes - startMinutes) / 60) * dayCount;
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
  const cleaned = value.replace(/\//g, ",").replace(/\s+/g, ",");
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
  const [paneSettings, setPaneSettings] = useState(loadPaneSettings);
  const [isTextView, setIsTextView] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [editorOpen, setEditorOpen] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const editorBaseline = useRef("");
  const leftTimetableRef = useRef<HTMLDivElement>(null);
  const rightTimetableRef = useRef<HTMLDivElement>(null);
  const captureTimetableRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef<PaneId | null>(null);
  const [capturePane, setCapturePane] = useState<PaneState | null>(null);
  const activePaneId = paneSettings.active;
  const activePane = paneSettings[activePaneId];
  const splitMode = paneSettings.split && !isTextView;
  const wideSplit = splitMode && viewportWidth >= 900;
  const viewMode: ViewMode = isTextView ? "text" : activePane.mode;
  const updatePane = (id: PaneId, update: Partial<PaneState>) => setPaneSettings(prev => ({ ...prev, [id]: { ...prev[id], ...update } }));
  const activatePane = (id: PaneId) => setPaneSettings(prev => prev.active === id ? prev : { ...prev, active: id });
  const setViewMode = (mode: ViewMode) => {
    setIsTextView(mode === "text");
    if (mode !== "text") updatePane(activePaneId, { mode });
  };
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { localStorage.setItem("scheduler.panes", JSON.stringify(paneSettings)); }, [paneSettings]);
  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>(".topbar, .content > .main");
    elements.forEach(element => { element.inert = splitMode && editorOpen; });
    return () => elements.forEach(element => { element.inert = false; });
  }, [splitMode, editorOpen]);
  const [showSunday, setShowSunday] = useState(false);
  const [useQuarterHours, setUseQuarterHours] = useState(false);
  const [selectionPaneId, setSelectionPaneId] = useState<PaneId>("left");
  const [selection, setSelection] = useState<Selection>(null);
  const [selectionEnd, setSelectionEnd] = useState<Selection>(null);
  const [lastSelection, setLastSelection] = useState<{
    day: string;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; paneId: PaneId } | null>(
    null
  );
  const [blockMenu, setBlockMenu] = useState<{
    x: number;
    y: number;
    entry: ScheduleEntry;
    day: string;
    paneId: PaneId;
  } | null>(null);
  const [copiedBlock, setCopiedBlock] = useState<ScheduleEntry | null>(null);
  const [filterText, setFilterText] = useState("");
  const [sortKey, setSortKey] = useState<typeof canonicalHeaders[number]>(
    "Course Code"
  );
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const selectedSection = activePane.section;
  const selectedFaculty = activePane.faculty;
  const selectedRoom = activePane.room;
  const setSelectedSection = (section: string | ((previous: string) => string)) => setPaneSettings(prev => ({ ...prev, [prev.active]: { ...prev[prev.active], section: typeof section === "function" ? section(prev[prev.active].section) : section } }));
  const setSelectedFaculty = (faculty: string | ((previous: string) => string)) => setPaneSettings(prev => ({ ...prev, [prev.active]: { ...prev[prev.active], faculty: typeof faculty === "function" ? faculty(prev[prev.active].faculty) : faculty } }));
  const setSelectedRoom = (room: string | ((previous: string) => string)) => setPaneSettings(prev => ({ ...prev, [prev.active]: { ...prev[prev.active], room: typeof room === "function" ? room(prev[prev.active].room) : room } }));
  const [scheduleForm, setScheduleForm] = useState<ScheduleEntry>(() =>
    buildEmptyScheduleForm()
  );
  const [formError, setFormError] = useState("");
  const [editEntryId, setEditEntryId] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState<ScheduleEntry | null>(null);
  const [editError, setEditError] = useState("");
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);
  const [selectionOrigin, setSelectionOrigin] = useState<{ day: string; index: number } | null>(
    null
  );
  const [dragging, setDragging] = useState<{
    entry: ScheduleEntry;
    day: string;
    duration: number;
    paneId: PaneId;
  } | null>(null);
  const [dragTarget, setDragTarget] = useState<{ day: string; startMinutes: number; paneId: PaneId } | null>(
    null
  );
  const [toast, setToast] = useState<{ message: string; showRevert: boolean } | null>(null);
  const [moveSnapshot, setMoveSnapshot] = useState<MoveSnapshot | null>(null);
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const setZoomPercent = (zoom: number) => updatePane(activePaneId, { zoom });
  const [formEditId, setFormEditId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSections, setExportSections] = useState(false);
  const [exportFaculty, setExportFaculty] = useState(false);
  const [exportRooms, setExportRooms] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    current: number;
    total: number;
    label: string;
    running: boolean;
  } | null>(null);
  const [exportCancelRequested, setExportCancelRequested] = useState(false);
  const [openExportSubmenu, setOpenExportSubmenu] = useState(false);
  const [isFacultyLoadExportOpen, setIsFacultyLoadExportOpen] = useState(false);
  const [facultyLoadExportNames, setFacultyLoadExportNames] = useState<string[]>([]);
  const [ignoreFaculty, setIgnoreFaculty] = useState(false);
  const [ignoreRoom, setIgnoreRoom] = useState(false);
  const [ignoreTba, setIgnoreTba] = useState(false);
  const [ignoreFacultyList, setIgnoreFacultyList] = useState<string[]>([]);
  const [ignoreRoomList, setIgnoreRoomList] = useState<string[]>([]);
  const [containsFaculty, setContainsFaculty] = useState(false);
  const [containsRoom, setContainsRoom] = useState(false);
  const [facultyInput, setFacultyInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [openMenu, setOpenMenu] = useState<"file" | "edit" | "export" | "rules" | null>(null);
  const [showFacultyRules, setShowFacultyRules] = useState(false);
  const [showRoomRules, setShowRoomRules] = useState(false);
  const [csvImportState, setCsvImportState] = useState<{
    file: File;
    summary: CsvImportSummary;
  } | null>(null);
  const [isCsvImporting, setIsCsvImporting] = useState(false);
  const [csvInputKey, setCsvInputKey] = useState(0);
  const [dbInputKey, setDbInputKey] = useState(0);
  const [curricula, setCurricula] = useState<Curriculum[]>([]);
  const [curriculumTerm, setCurriculumTerm] = useState<CurriculumTerm>("First Semester");
  const [curriculumPreview, setCurriculumPreview] = useState<{
    fileName: string;
    name: string;
    courses: CurriculumCourse[];
  } | null>(null);
  const [curriculumInputKey, setCurriculumInputKey] = useState(0);
  const [sectionYearLevels, setSectionYearLevels] = useState<Record<string, string>>({});
  const [yearLevelCurriculumIds, setYearLevelCurriculumIds] = useState<Record<string, string>>(
    {}
  );
  const [courseDescriptionSelections, setCourseDescriptionSelections] = useState<
    Record<string, string>
  >({});
  const [courseDescriptionPromptDismissedFor, setCourseDescriptionPromptDismissedFor] =
    useState("");
  const [isCourseDescriptionFixing, setIsCourseDescriptionFixing] = useState(false);
  const [customizeSettings, setCustomizeSettings] =
    useState<CustomizeSettings>(defaultCustomizeSettings);
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [selectedFacultyColor, setSelectedFacultyColor] = useState("");
  const [facultyColorInput, setFacultyColorInput] = useState("");
  const [facultyRgb, setFacultyRgb] = useState({ r: 0, g: 0, b: 0 });
  const [showFacultyAdvanced, setShowFacultyAdvanced] = useState(false);
  const [selectedSectionColor, setSelectedSectionColor] = useState("");
  const [sectionColorInput, setSectionColorInput] = useState("");
  const [sectionRgb, setSectionRgb] = useState({ r: 0, g: 0, b: 0 });
  const [showSectionAdvanced, setShowSectionAdvanced] = useState(false);
  const [entityEditorKind, setEntityEditorKind] = useState<EntityEditorKind>("section");
  const [isEntityEditorOpen, setIsEntityEditorOpen] = useState(false);
  const [entityNameDrafts, setEntityNameDrafts] = useState<Record<number, string>>({});
  const [newEntityName, setNewEntityName] = useState("");
  const [forceEntityRemove, setForceEntityRemove] = useState(false);
  const [entityEditorError, setEntityEditorError] = useState("");
  const [isCourseCodeMenuOpen, setIsCourseCodeMenuOpen] = useState(false);
  const [courseCodeMenuPosition, setCourseCodeMenuPosition] = useState({ top: 0, left: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const courseCodeRef = useRef<HTMLInputElement | null>(null);
  const timetableRef = activePaneId === "left" ? leftTimetableRef : rightTimetableRef;
  const exportCancelRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const customizeModalRef = useRef<HTMLDivElement | null>(null);
  const settingsSaveTimeout = useRef<number | null>(null);

  const curriculumCourses = useMemo(
    () => curricula.flatMap((curriculum) => curriculum.courses),
    [curricula]
  );

  const curriculumState = useMemo(
    () => ({
      curricula,
      selectedTerm: curriculumTerm,
      sectionYearLevels,
      yearLevelCurriculumIds,
    }),
    [curricula, curriculumTerm, sectionYearLevels, yearLevelCurriculumIds]
  );

  const conflictIgnoreSettings = useMemo(
    () => ({
      ignoreFaculty,
      ignoreRoom,
      ignoreTba,
      ignoreFacultyList,
      ignoreRoomList,
      containsFaculty,
      containsRoom,
    }),
    [
      ignoreFaculty,
      ignoreRoom,
      ignoreTba,
      ignoreFacultyList,
      ignoreRoomList,
      containsFaculty,
      containsRoom,
    ]
  );

  const applyConflictIgnoreSettings = (settings: ConflictIgnoreSettings) => {
    setIgnoreFaculty(settings.ignoreFaculty);
    setIgnoreRoom(settings.ignoreRoom);
    setIgnoreTba(settings.ignoreTba);
    setIgnoreFacultyList(settings.ignoreFacultyList);
    setIgnoreRoomList(settings.ignoreRoomList);
    setContainsFaculty(settings.containsFaculty);
    setContainsRoom(settings.containsRoom);
  };

  useEffect(() => {
    const storedProgram = localStorage.getItem("lastProgram");
    const storedSection = localStorage.getItem("lastSection");
    const storedZoom = localStorage.getItem("scheduler.panes") ? null : localStorage.getItem("timetableZoom");
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
    LEGACY_RULE_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    const storedCustomize = localStorage.getItem(CUSTOMIZE_STORAGE_KEY);
    if (storedCustomize) {
      try {
        const parsed = JSON.parse(storedCustomize) as CustomizeSettings;
        setCustomizeSettings(normalizeCustomizeSettings(parsed));
      } catch {
        setCustomizeSettings(defaultCustomizeSettings);
      }
    }
  }, []);

  const fetchConflicts = async (settings: ConflictIgnoreSettings = conflictIgnoreSettings) => {
    const params = new URLSearchParams();
    params.set("ignore_faculty", String(settings.ignoreFaculty));
    params.set("ignore_room", String(settings.ignoreRoom));
    params.set("ignore_tba", String(settings.ignoreTba));
    if (settings.ignoreFacultyList.length > 0) {
      params.set("ignore_faculty_list", settings.ignoreFacultyList.join(","));
    }
    if (settings.ignoreRoomList.length > 0) {
      params.set("ignore_room_list", settings.ignoreRoomList.join(","));
    }
    params.set("contains_faculty", String(settings.containsFaculty));
    params.set("contains_room", String(settings.containsRoom));
    const conflictsRes = await fetch(`${API_BASE}/conflicts?${params.toString()}`);
    setConflicts(await conflictsRes.json());
  };

  const buildLegacyCurriculumState = (): CurriculumState => {
    const storedState = localStorage.getItem(CURRICULUM_STATE_STORAGE_KEY);
    if (storedState) {
      try {
        return normalizeCurriculumState(JSON.parse(storedState) as Partial<CurriculumState>);
      } catch {
        // Fall through to older single-curriculum storage.
      }
    }
    const selectedTerm =
      normalizeSemester(localStorage.getItem(CURRICULUM_TERM_STORAGE_KEY) ?? "") ??
      defaultCurriculumState.selectedTerm;
    let curricula: Curriculum[] = [];
    const storedCurriculum = localStorage.getItem(CURRICULUM_STORAGE_KEY);
    const storedVersion = localStorage.getItem(CURRICULUM_STORAGE_VERSION_KEY);
    if (storedCurriculum && (storedVersion === "2" || storedVersion === CURRICULUM_STORAGE_VERSION)) {
      try {
        const parsed = JSON.parse(storedCurriculum) as CurriculumCourse[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          curricula = [
            {
              id: buildCurriculumId(),
              name: "Imported Curriculum",
              sourceFileName: "localStorage",
              importedAt: new Date().toISOString(),
              courses: parsed,
            },
          ];
        }
      } catch {
        curricula = [];
      }
    }
    let sectionYearLevels: Record<string, string> = {};
    const storedSectionYearLevels = localStorage.getItem(SECTION_YEAR_LEVELS_STORAGE_KEY);
    if (storedSectionYearLevels) {
      try {
        const parsed = JSON.parse(storedSectionYearLevels) as Record<string, string>;
        sectionYearLevels = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        sectionYearLevels = {};
      }
    }
    return {
      curricula,
      selectedTerm,
      sectionYearLevels,
      yearLevelCurriculumIds: {},
    };
  };

  const applyCurriculumState = (state: CurriculumState) => {
    const normalized = normalizeCurriculumState(state);
    setCurricula(normalized.curricula);
    setCurriculumTerm(normalized.selectedTerm);
    setSectionYearLevels(normalized.sectionYearLevels);
    setYearLevelCurriculumIds(normalized.yearLevelCurriculumIds);
  };

  const persistSettings = async (
    settings: CustomizeSettings,
    nextCurriculumState: CurriculumState,
    nextConflictIgnoreSettings: ConflictIgnoreSettings = conflictIgnoreSettings
  ) => {
    await fetch(`${API_BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          customize: settings,
          curriculumState: nextCurriculumState,
          conflictIgnore: nextConflictIgnoreSettings,
        },
      }),
    });
  };

  const loadSettingsFromServer = async (): Promise<ConflictIgnoreSettings> => {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) {
      applyCurriculumState(buildLegacyCurriculumState());
      applyConflictIgnoreSettings(defaultConflictIgnoreSettings);
      setSettingsLoaded(true);
      return defaultConflictIgnoreSettings;
    }
    const data = await res.json();
    const settings = data?.settings ?? {};
    const loadedConflictIgnoreSettings = settings.conflictIgnore
      ? normalizeConflictIgnoreSettings(settings.conflictIgnore)
      : defaultConflictIgnoreSettings;
    const hasSettings = settings && Object.keys(settings).length > 0;
    if (hasSettings) {
      if (settings.customize) {
        setCustomizeSettings(normalizeCustomizeSettings(settings.customize));
      } else if (isCustomizeSettingsShape(settings)) {
        setCustomizeSettings(normalizeCustomizeSettings(settings));
      }
    }
    if (settings.curriculumState) {
      applyCurriculumState(settings.curriculumState);
    } else {
      const legacyCurriculumState = buildLegacyCurriculumState();
      applyCurriculumState(legacyCurriculumState);
      if (legacyCurriculumState.curricula.length > 0 || Object.keys(legacyCurriculumState.sectionYearLevels).length > 0) {
        await persistSettings(
          settings.customize
            ? normalizeCustomizeSettings(settings.customize)
            : isCustomizeSettingsShape(settings)
              ? normalizeCustomizeSettings(settings)
              : customizeSettings,
          legacyCurriculumState,
          loadedConflictIgnoreSettings
        );
      }
    }
    applyConflictIgnoreSettings(loadedConflictIgnoreSettings);
    setSettingsLoaded(true);
    return loadedConflictIgnoreSettings;
  };

  const pushUndoAction = (action: UndoAction) => {
    setUndoStack((prev) => [action, ...prev].slice(0, 20));
  };

  const refreshAll = async (conflictSettings: ConflictIgnoreSettings = conflictIgnoreSettings) => {
    const [scheduleRes, sectionsRes, facultyRes, roomsRes] = await Promise.all([
      fetch(`${API_BASE}/schedule`),
      fetch(`${API_BASE}/sections`),
      fetch(`${API_BASE}/faculty`),
      fetch(`${API_BASE}/rooms`),
    ]);
    const nextEntries = await scheduleRes.json();
    const nextSections = await sectionsRes.json();
    const nextFaculty = await facultyRes.json();
    const nextRooms = await roomsRes.json();
    setEntries(nextEntries);
    setSections(nextSections);
    setFaculty(nextFaculty);
    setRooms(nextRooms);
    setScheduleLoaded(true);
    await fetchConflicts(conflictSettings);
  };

  useEffect(() => {
    const initialize = async () => {
      const loadedConflictIgnoreSettings = await loadSettingsFromServer();
      await refreshAll(loadedConflictIgnoreSettings);
    };
    initialize();
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    fetchConflicts();
  }, [
    ignoreFaculty,
    ignoreRoom,
    ignoreTba,
    ignoreFacultyList,
    ignoreRoomList,
    containsFaculty,
    containsRoom,
    settingsLoaded,
  ]);

  useEffect(() => {
    localStorage.setItem(CUSTOMIZE_STORAGE_KEY, JSON.stringify(customizeSettings));
    if (!settingsLoaded) return;
    if (settingsSaveTimeout.current) {
      window.clearTimeout(settingsSaveTimeout.current);
    }
    settingsSaveTimeout.current = window.setTimeout(() => {
      persistSettings(customizeSettings, curriculumState);
    }, 300);
    return () => {
      if (settingsSaveTimeout.current) {
        window.clearTimeout(settingsSaveTimeout.current);
      }
    };
  }, [customizeSettings, curriculumState, conflictIgnoreSettings, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    localStorage.setItem(CURRICULUM_TERM_STORAGE_KEY, curriculumTerm);
  }, [curriculumTerm, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    localStorage.setItem(SECTION_YEAR_LEVELS_STORAGE_KEY, JSON.stringify(sectionYearLevels));
  }, [sectionYearLevels, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    localStorage.setItem(CURRICULUM_STATE_STORAGE_KEY, JSON.stringify(curriculumState));
    localStorage.setItem(CURRICULUM_STORAGE_KEY, JSON.stringify(curriculumCourses));
    localStorage.setItem(CURRICULUM_STORAGE_VERSION_KEY, CURRICULUM_STORAGE_VERSION);
  }, [curriculumCourses, curriculumState, settingsLoaded]);

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

  const entityEditorConfig = useMemo(() => {
    if (entityEditorKind === "faculty") {
      return {
        kind: "faculty" as const,
        label: "Faculty",
        pluralLabel: "faculty",
        path: "faculty",
        entities: facultyOptions,
        field: "Faculty" as const,
      };
    }
    if (entityEditorKind === "room") {
      return {
        kind: "room" as const,
        label: "Room",
        pluralLabel: "rooms",
        path: "rooms",
        entities: roomOptions,
        field: "Room" as const,
      };
    }
    return {
      kind: "section" as const,
      label: "Section",
      pluralLabel: "sections",
      path: "sections",
      entities: sectionOptions,
      field: "Section" as const,
    };
  }, [entityEditorKind, facultyOptions, roomOptions, sectionOptions]);

  const calculateCourseSectionTotalHours = (
    candidate: ScheduleEntry,
    candidateId: number | null
  ) => {
    const curriculumCourse = getCurriculumCourse(candidate["Course Code"], candidate.Section);
    if (curriculumCourse) {
      return curriculumCourse.hours;
    }
    const sectionKey = normalizeMatchValue(candidate.Section);
    const courseKey = normalizeMatchValue(candidate["Course Code"]);
    const candidateHours = getEntryWeeklyHours(candidate);
    if (!sectionKey || !courseKey) {
      return roundHours(candidateHours);
    }
    const existingHours = entries
      .filter(
        (entry) =>
          entry.id !== candidateId &&
          normalizeMatchValue(entry.Section) === sectionKey &&
          normalizeMatchValue(entry["Course Code"]) === courseKey
      )
      .reduce((total, entry) => total + getEntryWeeklyHours(entry), 0);
    return roundHours(existingHours + candidateHours);
  };

  const activeCurriculumCourses = useMemo(
    () => curriculumCourses.filter((course) => course.semester === curriculumTerm),
    [curriculumCourses, curriculumTerm]
  );

  const getCurriculumById = (curriculumId: string) =>
    curricula.find((curriculum) => curriculum.id === curriculumId);

  const curriculumYearLevels = useMemo(() => {
    const yearLevels = new Set<string>();
    curriculumCourses.forEach((course) => {
      if (course.yearLevel.trim()) {
        yearLevels.add(course.yearLevel.trim());
      }
    });
    return [...yearLevels].sort(compareYearLevels);
  }, [curriculumCourses]);

  const getSectionYearLevel = (section: string) =>
    sectionYearLevels[normalizeMatchValue(section)] ?? "";

  const getYearLevelCurriculumId = (yearLevel: string) =>
    yearLevelCurriculumIds[normalizeMatchValue(yearLevel)] ?? "";

  const getYearLevelCurriculum = (yearLevel: string) => {
    const curriculumId = getYearLevelCurriculumId(yearLevel);
    return curriculumId ? getCurriculumById(curriculumId) : undefined;
  };

  const getSectionCurriculumScope = (section: string) => {
    const yearLevel = getSectionYearLevel(section);
    return {
      yearLevelKey: normalizeMatchValue(yearLevel),
      curriculumId: yearLevel ? getYearLevelCurriculumId(yearLevel) : "",
    };
  };

  const isSameCurriculumScope = (leftSection: string, rightSection: string) => {
    const left = getSectionCurriculumScope(leftSection);
    const right = getSectionCurriculumScope(rightSection);
    const hasScopedAssignment =
      left.yearLevelKey || right.yearLevelKey || left.curriculumId || right.curriculumId;
    if (!hasScopedAssignment) return true;
    return left.yearLevelKey === right.yearLevelKey && left.curriculumId === right.curriculumId;
  };

  const getCurriculumCoursesForSection = (section: string) => {
    const yearLevel = getSectionYearLevel(section);
    const assignedCurriculum = yearLevel ? getYearLevelCurriculum(yearLevel) : undefined;
    const courses = assignedCurriculum?.courses ?? curriculumCourses;
    const activeCourses = courses.filter((course) => course.semester === curriculumTerm);
    if (!yearLevel) return activeCourses;
    const yearLevelCourses = activeCourses.filter(
      (course) => normalizeMatchValue(course.yearLevel) === normalizeMatchValue(yearLevel)
    );
    return yearLevelCourses.length > 0 ? yearLevelCourses : activeCourses;
  };

  const getCurriculumCourse = (courseCode: string, section = "") => {
    const courseKey = normalizeMatchValue(courseCode);
    return getCurriculumCoursesForSection(section).find(
      (course) => normalizeMatchValue(course.courseCode) === courseKey
    );
  };

  const formSectionYearLevel = getSectionYearLevel(scheduleForm.Section);

  const getPlottedCourseHours = (
    section: string,
    courseCode: string,
    excludedEntryId: number | null = null
  ) => {
    const sectionKey = normalizeMatchValue(section);
    const courseKey = normalizeMatchValue(courseCode);
    if (!sectionKey || !courseKey) return 0;
    return roundHours(
      entries
        .filter(
          (entry) =>
            entry.id !== excludedEntryId &&
            normalizeMatchValue(entry.Section) === sectionKey &&
            normalizeMatchValue(entry["Course Code"]) === courseKey
        )
        .reduce((total, entry) => total + getEntryWeeklyHours(entry), 0)
    );
  };

  const getCoursePlotStatus = (
    courseCode: string,
    section = scheduleForm.Section,
    excludedEntryId: number | null = null
  ) => {
    const curriculumCourse = getCurriculumCourse(courseCode, section);
    const plottedHours = getPlottedCourseHours(section, courseCode, excludedEntryId);
    const requiredHours = curriculumCourse?.hours ?? null;
    return {
      plottedHours,
      requiredHours,
      isComplete:
        requiredHours !== null && Math.abs(roundHours(plottedHours - requiredHours)) < 0.01,
    };
  };

  const getCourseCodeOptionLabel = (courseCode: string) => {
    const canonicalDescription = getCanonicalCourseDescriptionForSection(
      courseCode,
      scheduleForm.Section
    );
    const status = getCoursePlotStatus(courseCode, scheduleForm.Section, null);
    const plottedLabel =
      status.requiredHours !== null
        ? `${formatHoursLabel(status.plottedHours)}/${formatHoursLabel(status.requiredHours)} hrs plotted`
        : `${formatHoursLabel(status.plottedHours)} hrs plotted`;
    return [canonicalDescription, plottedLabel].filter(Boolean).join(" - ");
  };

  const selectedCoursePlotStatus = getCoursePlotStatus(
    scheduleForm["Course Code"],
    scheduleForm.Section,
    null
  );

  const courseDescriptionCatalog = useMemo(() => {
    const descriptionsByCode: Record<string, Map<string, { label: string; ids: number[] }>> = {};
    const displayCodeByKey: Record<string, string> = {};
    activeCurriculumCourses.forEach((course) => {
      const codeKey = normalizeMatchValue(course.courseCode);
      const descriptionKey = normalizeMatchValue(course.courseDescription);
      if (!codeKey || !descriptionKey) return;
      displayCodeByKey[codeKey] = course.courseCode;
      if (!descriptionsByCode[codeKey]) {
        descriptionsByCode[codeKey] = new Map();
      }
      descriptionsByCode[codeKey].set(descriptionKey, {
        label: course.courseDescription,
        ids: [],
      });
    });
    entries.forEach((entry) => {
      const code = entry["Course Code"].trim();
      const description = entry["Course Description"].trim();
      if (!code || !description) return;
      const codeKey = normalizeMatchValue(code);
      const descriptionKey = normalizeMatchValue(description);
      displayCodeByKey[codeKey] = displayCodeByKey[codeKey] ?? code;
      if (!descriptionsByCode[codeKey]) {
        descriptionsByCode[codeKey] = new Map();
      }
      const existing = descriptionsByCode[codeKey].get(descriptionKey);
      if (existing) {
        existing.ids.push(entry.id);
      } else {
        descriptionsByCode[codeKey].set(descriptionKey, {
          label: description,
          ids: [entry.id],
        });
      }
    });

    const canonicalDescriptions: Record<string, string> = {};
    const conflicts: CourseDescriptionConflict[] = [];
    Object.entries(descriptionsByCode).forEach(([codeKey, descriptions]) => {
      const sortedDescriptions = [...descriptions.values()].sort((left, right) => {
        if (right.ids.length !== left.ids.length) {
          return right.ids.length - left.ids.length;
        }
        return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
      });
      canonicalDescriptions[codeKey] =
        activeCurriculumCourses.find(
          (course) => normalizeMatchValue(course.courseCode) === codeKey
        )?.courseDescription ??
        sortedDescriptions[0]?.label ??
        "";
      const scheduledDescriptions = sortedDescriptions.filter((item) => item.ids.length > 0);
      if (scheduledDescriptions.length > 1) {
        conflicts.push({
          codeKey,
          code: displayCodeByKey[codeKey],
          descriptions: scheduledDescriptions.map((item) => item.label),
          entryIdsByDescription: Object.fromEntries(
            scheduledDescriptions.map((item) => [item.label, item.ids])
          ),
        });
      }
    });

    return {
      canonicalDescriptions,
      conflicts: conflicts.sort((left, right) =>
        left.code.localeCompare(right.code, undefined, { sensitivity: "base" })
      ),
      courseCodes: Object.values(displayCodeByKey).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" })
      ),
    };
  }, [activeCurriculumCourses, entries]);

  const formCourseCodeOptions = useMemo(() => {
    const curriculumCodes = getCurriculumCoursesForSection(scheduleForm.Section).map(
      (course) => course.courseCode
    );
    const fallbackCodes = formSectionYearLevel
      ? entries
          .filter(
            (entry) =>
              normalizeMatchValue(entry.Section) === normalizeMatchValue(scheduleForm.Section)
          )
          .map((entry) => entry["Course Code"])
      : courseDescriptionCatalog.courseCodes;
    return [...new Set([...curriculumCodes, ...fallbackCodes])].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" })
    );
  }, [
    activeCurriculumCourses,
    courseDescriptionCatalog.courseCodes,
    entries,
    formSectionYearLevel,
    scheduleForm.Section,
    sectionYearLevels,
  ]);

  const visibleCourseCodeOptions = useMemo(() => {
    const query = normalizeMatchValue(scheduleForm["Course Code"]);
    const options = query
      ? formCourseCodeOptions.filter((courseCode) =>
          normalizeMatchValue(courseCode).includes(query)
        )
      : formCourseCodeOptions;
    return options.slice(0, 36);
  }, [formCourseCodeOptions, scheduleForm["Course Code"]]);

  const openCourseCodeMenu = () => {
    const rect = courseCodeRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = Math.min(620, window.innerWidth - 32);
      setCourseCodeMenuPosition({
        top: splitMode ? Math.min(window.innerHeight - 260, rect.bottom + 4) : Math.max(8, rect.top - 40),
        left: splitMode ? rect.left : Math.max(8, rect.left - menuWidth - 10),
      });
    }
    setIsCourseCodeMenuOpen(true);
  };

  const courseDescriptionConflictSignature = useMemo(
    () =>
      courseDescriptionCatalog.conflicts
        .map((conflict) => `${conflict.codeKey}:${conflict.descriptions.join("|")}`)
        .join(";"),
    [courseDescriptionCatalog.conflicts]
  );

  const activeCourseDescriptionConflicts =
    courseDescriptionConflictSignature &&
    courseDescriptionPromptDismissedFor !== courseDescriptionConflictSignature
      ? courseDescriptionCatalog.conflicts
      : [];

  useEffect(() => {
    if (!courseDescriptionConflictSignature) return;
    setCourseDescriptionSelections((prev) => {
      const next = { ...prev };
      courseDescriptionCatalog.conflicts.forEach((conflict) => {
        if (!next[conflict.codeKey] || !conflict.descriptions.includes(next[conflict.codeKey])) {
          next[conflict.codeKey] =
            courseDescriptionCatalog.canonicalDescriptions[conflict.codeKey] ??
            conflict.descriptions[0];
        }
      });
      return next;
    });
  }, [courseDescriptionCatalog, courseDescriptionConflictSignature]);

  const getCanonicalCourseDescription = (courseCode: string) =>
    getCurriculumCourse(courseCode, scheduleForm.Section)?.courseDescription ??
    courseDescriptionCatalog.canonicalDescriptions[normalizeMatchValue(courseCode)] ??
    "";

  const getCanonicalCourseDescriptionForSection = (courseCode: string, section: string) =>
    getCurriculumCourse(courseCode, section)?.courseDescription ??
    courseDescriptionCatalog.canonicalDescriptions[normalizeMatchValue(courseCode)] ??
    "";

  const withCanonicalCourseDescription = (entry: ScheduleEntry) => {
    const canonical = getCanonicalCourseDescriptionForSection(entry["Course Code"], entry.Section);
    const curriculumCourse = getCurriculumCourse(entry["Course Code"], entry.Section);
    return {
      ...entry,
      "Course Description": canonical || entry["Course Description"],
      Units: curriculumCourse?.totalUnits ?? entry.Units,
      "# of Hours": curriculumCourse?.hours ?? entry["# of Hours"],
      Program: curriculumCourse?.program || entry.Program,
    };
  };

  const updateMatchingCourseDescriptions = async (
    source: ScheduleEntry,
    sourceId: number | null
  ) => {
    const codeKey = normalizeMatchValue(source["Course Code"]);
    const description = source["Course Description"].trim();
    if (!codeKey || !description) return;
    const updates = entries
      .filter(
        (entry) =>
          entry.id !== sourceId &&
          normalizeMatchValue(entry["Course Code"]) === codeKey &&
          isSameCurriculumScope(entry.Section, source.Section) &&
          entry["Course Description"].trim() !== description
      )
      .map((entry) =>
        fetch(`${API_BASE}/schedule/${entry.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...entry, "Course Description": description }),
        })
      );
    await Promise.all(updates);
  };

  const applyCourseCodeToScheduleForm = (courseCode: string) => {
    setScheduleForm((prev) => ({
      ...prev,
      "Course Code": courseCode,
      "Course Description":
        getCanonicalCourseDescriptionForSection(courseCode, prev.Section) ||
        prev["Course Description"],
      Units: getCurriculumCourse(courseCode, prev.Section)?.totalUnits ?? prev.Units,
      "# of Hours":
        getCurriculumCourse(courseCode, prev.Section)?.hours ?? prev["# of Hours"],
      Program: getCurriculumCourse(courseCode, prev.Section)?.program || prev.Program,
    }));
  };

  const applyCourseCodeToEditEntry = (courseCode: string) => {
    setEditEntry((prev) =>
      prev
        ? {
            ...prev,
            "Course Code": courseCode,
            "Course Description":
              getCanonicalCourseDescriptionForSection(courseCode, prev.Section) ||
              prev["Course Description"],
            Units: getCurriculumCourse(courseCode, prev.Section)?.totalUnits ?? prev.Units,
            "# of Hours":
              getCurriculumCourse(courseCode, prev.Section)?.hours ?? prev["# of Hours"],
            Program: getCurriculumCourse(courseCode, prev.Section)?.program || prev.Program,
          }
        : prev
    );
  };

  const applyCourseDescriptionFixes = async () => {
    if (activeCourseDescriptionConflicts.length === 0 || isCourseDescriptionFixing) return;
    setIsCourseDescriptionFixing(true);
    const updates = activeCourseDescriptionConflicts.flatMap((conflict) => {
      const selectedDescription =
        courseDescriptionSelections[conflict.codeKey] ??
        courseDescriptionCatalog.canonicalDescriptions[conflict.codeKey] ??
        conflict.descriptions[0];
      return entries
        .filter(
          (entry) =>
            normalizeMatchValue(entry["Course Code"]) === conflict.codeKey &&
            entry["Course Description"].trim() !== selectedDescription
        )
        .map((entry) =>
          fetch(`${API_BASE}/schedule/${entry.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...entry,
              "Course Description": selectedDescription,
            }),
          })
        );
    });
    await Promise.all(updates);
    setCourseDescriptionPromptDismissedFor(courseDescriptionConflictSignature);
    setToast({ message: "Course descriptions fixed", showRevert: false });
    await refreshAll();
    setIsCourseDescriptionFixing(false);
  };

  const withCalculatedHours = (entry: ScheduleEntry, entryId: number | null) => ({
    ...entry,
    "# of Hours": calculateCourseSectionTotalHours(entry, entryId),
  });

  const updateMatchingCourseSectionHours = async (
    source: ScheduleEntry,
    sourceId: number | null
  ) => {
    const sectionKey = normalizeMatchValue(source.Section);
    const courseKey = normalizeMatchValue(source["Course Code"]);
    if (!sectionKey || !courseKey) return;
    const totalHours = calculateCourseSectionTotalHours(source, sourceId);
    const updates = entries
      .filter(
        (entry) =>
          entry.id !== sourceId &&
          normalizeMatchValue(entry.Section) === sectionKey &&
          normalizeMatchValue(entry["Course Code"]) === courseKey &&
          entry["# of Hours"] !== totalHours
      )
      .map((entry) =>
        fetch(`${API_BASE}/schedule/${entry.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...entry, "# of Hours": totalHours }),
        })
      );
    await Promise.all(updates);
  };

  const updateCourseSectionHoursAfterRemoval = async (removed: ScheduleEntry) => {
    const sectionKey = normalizeMatchValue(removed.Section);
    const courseKey = normalizeMatchValue(removed["Course Code"]);
    if (!sectionKey || !courseKey) return;
    const remaining = entries.filter(
      (entry) =>
        entry.id !== removed.id &&
        normalizeMatchValue(entry.Section) === sectionKey &&
        normalizeMatchValue(entry["Course Code"]) === courseKey
    );
    const totalHours =
      getCurriculumCourse(removed["Course Code"], removed.Section)?.hours ??
      roundHours(remaining.reduce((total, entry) => total + getEntryWeeklyHours(entry), 0));
    await Promise.all(
      remaining
        .filter((entry) => entry["# of Hours"] !== totalHours)
        .map((entry) =>
          fetch(`${API_BASE}/schedule/${entry.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...entry, "# of Hours": totalHours }),
          })
        )
    );
  };

  useEffect(() => {
    setScheduleForm((prev) => {
      const calculatedHours = calculateCourseSectionTotalHours(prev, formEditId);
      if (prev["# of Hours"] === calculatedHours) {
        return prev;
      }
      return { ...prev, "# of Hours": calculatedHours };
    });
  }, [
    entries,
    formEditId,
    scheduleForm.Section,
    scheduleForm["Course Code"],
    scheduleForm["Time (LPU Std)"],
    scheduleForm["Time (24 Hrs)"],
    scheduleForm.Days,
    curriculumTerm,
    curriculumCourses,
    sectionYearLevels,
    yearLevelCurriculumIds,
  ]);

  useEffect(() => {
    if (!scheduleLoaded) return;
    setPaneSettings(prev => {
      const next = { ...prev };
      let changed = false;
      for (const id of ["left", "right"] as const) {
        const pane = { ...prev[id] };
        for (const [kind, options] of [["section", sectionOptions], ["faculty", facultyOptions], ["room", roomOptions]] as const) {
          if (!options.some(entity => entity.name === pane[kind])) {
            const name = options[0]?.name ?? "";
            if (pane[kind] !== name) { pane[kind] = name; changed = true; }
          }
        }
        next[id] = pane;
      }
      return changed ? next : prev;
    });
  }, [scheduleLoaded, sectionOptions, facultyOptions, roomOptions]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDragging(null);
        setDragTarget(null);
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

  const handleSelectStart = (event: React.MouseEvent, day: string, index: number, paneId: PaneId) => {
    activatePane(paneId);
    setSelectionPaneId(paneId);
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

  const handleDragStart = (entry: ScheduleEntry, day: string, paneId: PaneId) => {
    if (isSaving || editorOpen || isExporting) return;
    activatePane(paneId);
    const parsed = parseTimeRange(entry["Time (24 Hrs)"]);
    if (!parsed) return;
    const { start, end } = parsed;
    setDragging({ entry, day, duration: end - start, paneId });
    setDragTarget({ day, startMinutes: start, paneId });
    setToast(null);
    setMoveSnapshot(null);
  };

  const handleDragOver = (event: React.DragEvent, day: string, slot: number, paneId: PaneId) => {
    event.preventDefault();
    if (!dragging) return;
    setDragTarget({ day, startMinutes: slot, paneId });
  };

  const formatDaysForDisplay = (days: string) => {
    if (!days || days.toLowerCase() === "tba") return "TBA";
    return normalizeDays(days)
      .split(",")
      .map((day) => dayLabels[day] ?? day)
      .join(", ");
  };

  const buildConflictMessage = (
    conflictsList: MoveConflictDetail[],
    lead = "Move blocked"
  ) => {
    const details = conflictsList.map((conflict) => {
      const entry = conflict.entry;
      const typeLabel = conflict.conflict_type.toUpperCase();
      const owner =
        conflict.conflict_type === "section"
          ? entry.Section
          : conflict.conflict_type === "room"
            ? entry.Room
            : entry.Faculty;
      const timeLabel =
        entry["Time (LPU Std)"] && entry["Time (LPU Std)"].toLowerCase() !== "tba"
          ? entry["Time (LPU Std)"].replace("-", "–")
          : "TBA";
      const daysLabel = formatDaysForDisplay(entry.Days);
      return `${typeLabel} ${owner} — ${entry.Section} / ${entry["Course Code"]} — ${daysLabel} ${timeLabel} (Room ${entry.Room}, Faculty ${entry.Faculty})`;
    });
    return `${lead}: conflicts with ${details.join(" | ")}.`;
  };

  const checkMoveConflicts = async (entry: ScheduleEntry, payload: ScheduleEntry): Promise<MoveCheckResponse> => {
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
    return await requestJson(
      `${API_BASE}/schedule/${entry.id}/move-check?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

  };

  const requestJson = async (url: string, options: RequestInit) => {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.detail;
      throw new Error(typeof detail === "string" ? detail : detail?.conflicts?.length ? buildConflictMessage(detail.conflicts) : detail?.message ?? "Could not save changes.");
    }
    return body;
  };

  const handleDrop = async (paneId: PaneId) => {
    if (!dragging || !dragTarget || dragTarget.paneId !== paneId || isSaving) return;
    const destination = paneSettings[paneId];
    activatePane(paneId);
    const assignment = assignmentForPane(destination);
    const { entry, day } = dragging;
    if (!assignment.name || dragTarget.startMinutes < 420 || dragTarget.startMinutes + dragging.duration > 1260) {
      setToast({ message: "Choose a destination and a time between 7 AM and 9 PM.", showRevert: false });
      setDragging(null); setDragTarget(null); return;
    }
    setIsSaving(true);
    try {
      const curriculumHours: Record<string, number> = {};
      for (const section of [entry.Section, assignment.kind === "section" ? assignment.name : entry.Section]) {
        const course = getCurriculumCourse(entry["Course Code"], section);
        if (course) curriculumHours[normalizeMatchValue(section)] = course.hours;
      }
      const result = await requestJson(`${API_BASE}/schedule/${entry.id}/move`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_day: day, destination_day: dragTarget.day, start_minutes: dragTarget.startMinutes,
          assignment: dragging.paneId !== paneId ? assignment : null, expected: entry,
          curriculum_hours: curriculumHours,
          conflict_settings: { ignore_faculty: ignoreFaculty, ignore_room: ignoreRoom, ignore_tba: ignoreTba,
            ignore_faculty_list: ignoreFacultyList, ignore_room_list: ignoreRoomList, contains_faculty: containsFaculty, contains_room: containsRoom } }),
      });
      if (result.snapshot) {
        const snapshot: MoveSnapshot = { previousEntries: result.snapshot.before, atomic: result.snapshot };
        setMoveSnapshot(snapshot);
        pushUndoAction({ type: "move", snapshot, label: "Move Class" });
        setSelectedEntryId(result.moved_entry_id);
        setToast({ message: "Class moved", showRevert: true });
        await refreshAll();
      }
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Move failed", showRevert: false });
    } finally {
      setDragging(null); setDragTarget(null); setLastSelection(null); setSelection(null);
      setSelectionEnd(null); setSelectionOrigin(null); setIsSaving(false);
    }
  };

  const revertMoveSnapshot = async (snapshot: MoveSnapshot) => {
    await requestJson(`${API_BASE}/schedule/${snapshot.previousEntries[0].id}/move/revert`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot.atomic),
    });
  };

  const handleRevertMove = async () => {
    if (!moveSnapshot || isSaving) return;
    setIsSaving(true);
    try {
      await revertMoveSnapshot(moveSnapshot);
      setUndoStack(prev => prev.filter(action => action.type !== "move" || action.snapshot !== moveSnapshot));
      setMoveSnapshot(null);
      setSelectedEntryId(moveSnapshot.previousEntries[0].id);
      setToast({ message: "Move reverted", showRevert: false });
      await refreshAll();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Could not revert move", showRevert: false });
    } finally { setIsSaving(false); }
  };

  const handleUndo = async () => {
    if (undoStack.length === 0 || isSaving) return;
    const [action, ...rest] = undoStack;
    setIsSaving(true);
    try {
      if (action.type === "add") {
        await requestJson(`${API_BASE}/schedule/${action.entryId}`, { method: "DELETE" });
      } else if (action.type === "delete") {
        const { id, ...restEntry } = action.entry;
        await requestJson(`${API_BASE}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(restEntry),
        });
      } else if (action.type === "edit") {
        await requestJson(`${API_BASE}/schedule/${action.entry.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action.entry),
        });
      } else if (action.type === "move") {
        await revertMoveSnapshot(action.snapshot);
      }
      setUndoStack(rest);
      setMoveSnapshot(null);
      setToast({ message: `Undid: ${action.label}`, showRevert: false });
      await refreshAll();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Undo failed", showRevert: false });
    } finally { setIsSaving(false); }
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

  const handleContextMenu = (event: React.MouseEvent, paneId: PaneId) => {
    activatePane(paneId);
    setSelectionPaneId(paneId);
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const cell = target?.closest<HTMLElement>("[data-day][data-slot]");
    const inGrid = Boolean(target?.closest(".timetable-grid"));
    if (target?.closest(".block")) {
      return;
    }
    if (selectionRange && selectionPaneId === paneId) {
      if (inGrid) {
        if (!cell) {
          setContextMenu({ x: event.clientX, y: event.clientY, paneId });
          return;
        }
        const day = cell.dataset.day ?? "";
        const slot = Number(cell.dataset.slot ?? 0);
        if (
          selectionRange.day === day &&
          slot >= selectionRange.startMinutes &&
          slot < selectionRange.endMinutes
        ) {
          setContextMenu({ x: event.clientX, y: event.clientY, paneId });
        }
        return;
      }
      setContextMenu({ x: event.clientX, y: event.clientY, paneId });
      return;
    }
    if (!cell) return;
    const day = cell.dataset.day ?? "";
    const slot = Number(cell.dataset.slot ?? 0);
    const endMinutes = slot + interval;
    setLastSelection({ day, startMinutes: slot, endMinutes });
    setContextMenu({ x: event.clientX, y: event.clientY, paneId });
  };

  const applySelectionToForm = () => {
    if (!selectionRange || selectionPaneId !== activePaneId) return;
    if (splitMode) {
      openAddClass(activePaneId);
      setContextMenu(null);
      return;
    }
    const time24 = `${formatMinutes(selectionRange.startMinutes)}-${formatMinutes(
      selectionRange.endMinutes
    )}`;
    setFormEditId(null);
    setSelectedEntryId(null);
    setFormError("");
    setScheduleForm({
      ...buildEmptyScheduleForm(),
      Section: viewMode === "timetable-section" ? currentViewConfig.selected : "",
      Faculty: viewMode === "timetable-faculty" ? currentViewConfig.selected : "",
      Room: viewMode === "timetable-room" ? currentViewConfig.selected : "",
      "Time (24 Hrs)": time24,
      "Time (LPU Std)": toLpuLabel(selectionRange.startMinutes, selectionRange.endMinutes),
      Days: selectionRange.day,
    });
    setContextMenu(null);
    if (panelRef.current) {
      panelRef.current.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => {
        courseCodeRef.current?.focus();
      }, 150);
    }
  };

  const getNextDay = (day: string) => {
    const index = daysOfWeek.indexOf(day);
    if (index === -1) return "";
    return daysOfWeek[(index + 1) % daysOfWeek.length];
  };

  const handleBlockContextMenu = (
    event: React.MouseEvent,
    entry: ScheduleEntry,
    day: string,
    paneId: PaneId
  ) => {
    event.preventDefault();
    activatePane(paneId);
    setBlockMenu({ x: event.clientX, y: event.clientY, entry, day, paneId });
  };

  const copyBlock = () => {
    if (!blockMenu) return;
    setCopiedBlock(blockMenu.entry);
    setToast({
      message: `Copied ${blockMenu.entry["Course Code"]} from ${blockMenu.entry.Section}`,
      showRevert: false,
    });
    setBlockMenu(null);
  };

  const pasteCopiedBlockToCurrentSection = async () => {
    if (!copiedBlock || isSaving) return;
    if (viewMode !== "timetable-section" || !currentViewConfig.selected) {
      setToast({ message: "Paste is available in section timetable view.", showRevert: false });
      setContextMenu(null);
      return;
    }
    try {
      const targetSection = currentViewConfig.selected;
      let payload = withCalculatedHours(
        withCanonicalCourseDescription({
          ...copiedBlock,
          id: 0,
          Section: targetSection,
        }),
        null
      );
      const pasteCheck = await checkMoveConflicts(payload, payload);
      if (!pasteCheck.ok && pasteCheck.reason === "conflict" && pasteCheck.conflicts?.length) {
        payload = withCalculatedHours(
          withCanonicalCourseDescription({
            ...payload,
            Room: "TBA",
            Faculty: "TBA",
          }),
          null
        );
      }
      setIsSaving(true);
      const created = await requestJson(`${API_BASE}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (created?.id) {
        await updateMatchingCourseDescriptions({ ...payload, id: created.id }, created.id);
        await updateMatchingCourseSectionHours({ ...payload, id: created.id }, created.id);
        pushUndoAction({
          type: "add",
          entryId: created.id,
          label: `Paste Class: ${payload["Course Code"]}`,
        });
        setToast({
          message:
            !pasteCheck.ok && pasteCheck.reason === "conflict"
              ? `Pasted ${payload["Course Code"]} to ${targetSection} with TBA room/faculty`
              : `Pasted ${payload["Course Code"]} to ${targetSection}`,
          showRevert: false,
        });
      }
      setContextMenu(null);
      setBlockMenu(null);
      await refreshAll();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Could not save class", showRevert: false });
    } finally { setIsSaving(false); }
  };

  const duplicateEntryToNextDay = async (entry: ScheduleEntry, day: string) => {
    if (isSaving) return;
    try {
      const nextDay = getNextDay(day);
      if (!nextDay) return;
      const payload = withCalculatedHours(
        withCanonicalCourseDescription({
          ...entry,
          id: 0,
          Days: nextDay,
        }),
        null
      );
      const duplicateCheck = await checkMoveConflicts(payload, payload);
      if (
        !duplicateCheck.ok &&
        duplicateCheck.reason === "conflict" &&
        duplicateCheck.conflicts?.length
      ) {
        setToast({ message: buildConflictMessage(duplicateCheck.conflicts), showRevert: false });
        setBlockMenu(null);
        return;
      }
      setIsSaving(true);
      const created = await requestJson(`${API_BASE}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (created?.id) {
        await updateMatchingCourseDescriptions({ ...payload, id: created.id }, created.id);
        await updateMatchingCourseSectionHours({ ...payload, id: created.id }, created.id);
        pushUndoAction({
          type: "add",
          entryId: created.id,
          label: `Duplicate Class: ${entry["Course Code"]}`,
        });
        setToast({ message: `Duplicated to ${dayLabels[nextDay]}`, showRevert: false });
      }
      setBlockMenu(null);
      await refreshAll();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Could not save class", showRevert: false });
    } finally { setIsSaving(false); }
  };

  const resetScheduleFormFields = () => {
    setScheduleForm((prev) =>
      buildEmptyScheduleForm({
        Program: prev.Program,
        Section: prev.Section,
      })
    );
  };

  const enterEditMode = (entry: ScheduleEntry) => {
    if (isSaving) return;
    editorBaseline.current = draftFingerprint(entry);
    if (splitMode) setEditorOpen(true);
    setFormEditId(entry.id);
    setScheduleForm(entry);
    setFormError("");
    setBlockMenu(null);
    setSelectedEntryId(entry.id);
    if (panelRef.current) {
      panelRef.current.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(() => {
        courseCodeRef.current?.focus();
      }, 150);
    }
  };

  const cancelEditMode = () => {
    if (isSaving) return;
    if (editorOpen && editorBaseline.current && draftFingerprint(scheduleForm) !== editorBaseline.current && !window.confirm("Discard unsaved class changes?")) return;
    setEditorOpen(false);
    setFormEditId(null);
    setFormError("");
    setSelectedEntryId(null);
    resetScheduleFormFields();
  };

  const saveFormEdit = async () => {
    if (formEditId === null) return;
    if (isSaving) return;
    const previousEntry = entries.find((item) => item.id === formEditId);
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
    try {
      const payload = withCalculatedHours(
        withCanonicalCourseDescription({ ...scheduleForm, Days: normalizedDays }),
        formEditId
      );
      await ensureEntityExists("sections", payload.Section, sections);
      await ensureEntityExists("faculty", payload.Faculty, faculty);
      await ensureEntityExists("rooms", payload.Room, rooms);
      const editCheck = await checkMoveConflicts(
        { ...payload, id: formEditId } as ScheduleEntry,
        payload
      );
      if (!editCheck.ok && editCheck.reason === "conflict" && editCheck.conflicts?.length) {
        setFormError(buildConflictMessage(editCheck.conflicts));
        setIsSaving(false);
        return;
      }
      await requestJson(`${API_BASE}/schedule/${formEditId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await updateMatchingCourseDescriptions(payload, formEditId);
      await updateMatchingCourseSectionHours(payload, formEditId);
      if (
        previousEntry &&
        (normalizeMatchValue(previousEntry.Section) !== normalizeMatchValue(payload.Section) ||
          normalizeMatchValue(previousEntry["Course Code"]) !==
            normalizeMatchValue(payload["Course Code"]))
      ) {
        await updateCourseSectionHoursAfterRemoval(previousEntry);
      }
      setFormEditId(null);
      setToast({ message: formEditId ? "Class updated" : "Class added", showRevert: false });
      if (previousEntry) {
        pushUndoAction({
          type: "edit",
          entry: previousEntry,
          label: `Edit Class: ${previousEntry["Course Code"]}`,
        });
      }
      await refreshAll();
      setEditorOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save class.");
    } finally { setIsSaving(false); }
  };

  const deleteEntry = async (entry: ScheduleEntry) => {
    if (isSaving) return;
    const confirmed = window.confirm("Delete this class?");
    if (!confirmed) return;
    setIsSaving(true);
    await fetch(`${API_BASE}/schedule/${entry.id}`, { method: "DELETE" });
    await updateCourseSectionHoursAfterRemoval(entry);
    setBlockMenu(null);
    pushUndoAction({
      type: "delete",
      entry,
      label: `Delete Class: ${entry["Course Code"]}`,
    });
    setToast({ message: "Deleted", showRevert: false });
    await refreshAll();
    setIsSaving(false);
  };

  const captureElementToPng = async (element: HTMLElement) => {
    element.classList.add("export-mode");
    const previousHeight = element.style.height;
    const previousOverflow = element.style.overflow;
    const previousWidth = element.style.width;
    const previousTop = element.scrollTop;
    const previousLeft = element.scrollLeft;
    element.style.height = `${element.scrollHeight}px`;
    element.style.width = `${element.scrollWidth}px`;
    element.style.overflow = "visible";
    element.scrollTop = 0;
    element.scrollLeft = 0;
    try {
      const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale: 2,
      });
      return canvas.toDataURL("image/png");
    } finally {
      element.style.height = previousHeight;
      element.style.width = previousWidth;
      element.style.overflow = previousOverflow;
      element.classList.remove("export-mode");
      element.scrollTop = previousTop;
      element.scrollLeft = previousLeft;
    }
  };

  const exportTimetablePng = async (
    selectionOverride?: string,
    modeOverride?: ViewMode,
    force = false
  ) => {
    const selectionName = selectionOverride ?? currentViewConfig.selected;
    const captureElement = force ? captureTimetableRef.current : timetableRef.current;
    if (!captureElement || !selectionName) return;
    if (isExporting && !force) return;
    if (!force) {
      setIsExporting(true);
    }
    try {
      const dataUrl = await captureElementToPng(captureElement);
      const link = document.createElement("a");
      const modeLabel = (modeOverride ?? viewMode).split("-")[1] ?? "timetable";
      const safeName = selectionName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/(^_|_$)/g, "");
      link.download = `timetable_${modeLabel}_${safeName || "export"}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      if (force) throw error;
      setToast({ message: error instanceof Error ? error.message : "Export failed", showRevert: false });
    } finally { if (!force) setIsExporting(false); }
  };

  const exportDelayMs = 150;

  const exportTimetablePngFor = async (
    selectionName: string,
    mode: ViewMode,
    progressLabel: string,
    current: number,
    total: number
  ) => {
    if (exportCancelRef.current) return;
    setCapturePane({ ...activePane, mode: mode as TimetableMode, [paneField(mode as TimetableMode)]: selectionName, zoom: 100, scrollTop: 0, scrollLeft: 0 });
    setExportProgress({ current, total, label: progressLabel, running: true });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => setTimeout(resolve, exportDelayMs));
    await exportTimetablePng(selectionName, mode, true);
  };

  const exportBatch = async () => {
    if (isExporting) return;
    const queue: Array<{ name: string; mode: ViewMode; label: string }> = [];
    if (exportSections) {
      sectionOptions.forEach((item) => {
        queue.push({ name: item.name, mode: "timetable-section", label: `SECTION: ${item.name}` });
      });
    }
    if (exportFaculty) {
      facultyOptions.forEach((item) => {
        queue.push({ name: item.name, mode: "timetable-faculty", label: `FACULTY: ${item.name}` });
      });
    }
    if (exportRooms) {
      roomOptions.forEach((item) => {
        queue.push({ name: item.name, mode: "timetable-room", label: `ROOM: ${item.name}` });
      });
    }
    const total = queue.length;
    if (total === 0) return;
    exportCancelRef.current = false;
    setExportCancelRequested(false);
    setIsExporting(true);
    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (exportCancelRef.current) break;
        const item = queue[index];
        const sanitized = sanitizeFilename(item.name);
        if (!sanitized) continue;
        await exportTimetablePngFor(item.name, item.mode, item.label, index + 1, total);
        if (exportCancelRef.current) break;
        await new Promise((resolve) => setTimeout(resolve, exportDelayMs));
      }
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Export failed", showRevert: false });
    } finally {
      setCapturePane(null);
      setExportProgress(null);
      setIsExporting(false);
      setExportCancelRequested(false);
    }
  };

  const ensureEntityExists = async (path: string, name: string, entities: NamedEntity[]) => {
    if (!name.trim()) return;
    const exists = entities.some(
      (entity) => entity.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (exists) return;
    await requestJson(`${API_BASE}/${path}`, {
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
    try {
      await ensureEntityExists("sections", scheduleForm.Section, sections);
      await ensureEntityExists("faculty", scheduleForm.Faculty, faculty);
      await ensureEntityExists("rooms", scheduleForm.Room, rooms);

      const payload = withCalculatedHours(
        withCanonicalCourseDescription({
          ...scheduleForm,
          Days: normalizedDays,
          "Time (LPU Std)": isTbaEntry ? "TBA" : scheduleForm["Time (LPU Std)"],
          "Time (24 Hrs)": "",
        }),
        null
      );
      const createCheck = await checkMoveConflicts({ ...payload, id: 0 } as ScheduleEntry, payload);
      if (!createCheck.ok && createCheck.reason === "conflict" && createCheck.conflicts?.length) {
        setFormError(buildConflictMessage(createCheck.conflicts));
        setIsSaving(false);
        return;
      }
      const created = await requestJson(`${API_BASE}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (created?.id) {
        await updateMatchingCourseDescriptions({ ...payload, id: created.id }, created.id);
        await updateMatchingCourseSectionHours({ ...payload, id: created.id }, created.id);
        pushUndoAction({
          type: "add",
          entryId: created.id,
          label: `Add Class: ${payload["Course Code"]}`,
        });
      }
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
      setSelectedEntryId(null);
      setToast({ message: "Class added", showRevert: false });
      await refreshAll();
      setEditorOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save class.");
    } finally { setIsSaving(false); }
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
    if (isSaving) return;
    const previousEntry = entries.find((item) => item.id === editEntryId);
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
    const payload = withCalculatedHours(
      withCanonicalCourseDescription({
        ...editEntry,
        Days: normalizedDays,
        "Time (LPU Std)": isTbaEntry ? "TBA" : editEntry["Time (LPU Std)"],
        "Time (24 Hrs)": "",
      }),
      editEntryId
    );
    setIsSaving(true);
    await ensureEntityExists("sections", payload.Section, sections);
    await ensureEntityExists("faculty", payload.Faculty, faculty);
    await ensureEntityExists("rooms", payload.Room, rooms);
    const editCheck = await checkMoveConflicts(
      { ...payload, id: editEntryId } as ScheduleEntry,
      payload
    );
    if (!editCheck.ok && editCheck.reason === "conflict" && editCheck.conflicts?.length) {
      setEditError(buildConflictMessage(editCheck.conflicts));
      setIsSaving(false);
      return;
    }
    const updateResponse = await fetch(`${API_BASE}/schedule/${editEntryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!updateResponse.ok) {
      const body = await updateResponse.json().catch(() => null);
      setEditError(body?.detail ?? "Could not save changes.");
      setIsSaving(false);
      return;
    }
    await updateMatchingCourseDescriptions(payload, editEntryId);
    await updateMatchingCourseSectionHours(payload, editEntryId);
    if (
      previousEntry &&
      (normalizeMatchValue(previousEntry.Section) !== normalizeMatchValue(payload.Section) ||
        normalizeMatchValue(previousEntry["Course Code"]) !==
          normalizeMatchValue(payload["Course Code"]))
    ) {
      await updateCourseSectionHoursAfterRemoval(previousEntry);
    }
    setEditEntryId(null);
    setEditEntry(null);
    if (previousEntry) {
      pushUndoAction({
        type: "edit",
        entry: previousEntry,
        label: `Edit Class: ${previousEntry["Course Code"]}`,
      });
    }
    await refreshAll();
    setIsSaving(false);
  };

  const handleDeleteEntry = async (entryId: number) => {
    const entry = entries.find((item) => item.id === entryId);
    await fetch(`${API_BASE}/schedule/${entryId}`, { method: "DELETE" });
    if (entry) {
      await updateCourseSectionHoursAfterRemoval(entry);
    }
    if (entry) {
      pushUndoAction({
        type: "delete",
        entry,
        label: `Delete Class: ${entry["Course Code"]}`,
      });
    }
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
    setLastSelection(null);
    setSelectionEnd(null);
    setSelectionOrigin(null);
    setMoveSnapshot(null);
    setUndoStack([]);
    setToast(null);
    setFormEditId(null);
    setSelectedEntryId(null);
    setScheduleForm(buildEmptyScheduleForm());
    refreshAll();
  };

  const handleExportDb = async () => {
    await persistSettings(customizeSettings, curriculumState);
    const res = await fetch(`${API_BASE}/file/export`);
    const blob = await res.blob();
    downloadBlob(blob, "scheduler.db");
  };

  const handleImportDb = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${API_BASE}/file/import`, { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail ?? `Could not open timetable (${response.status})`);
      }
      setUndoStack([]);
      const loadedConflictIgnoreSettings = await loadSettingsFromServer();
      await refreshAll(loadedConflictIgnoreSettings);
      setToast({ message: `Opened ${file.name}`, showRevert: false });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Could not open timetable",
        showRevert: false,
      });
    } finally {
      setDbInputKey((prev) => prev + 1);
    }
  };

  const handleImportCsvPreview = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE}/file/import-csv?preview=true`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Could not read CSV (${res.status})`);
      }
      const summary = (await res.json()) as CsvImportSummary;
      setCsvImportState({ file, summary });
      setOpenMenu(null);
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Could not read CSV",
        showRevert: false,
      });
    } finally {
      setCsvInputKey((prev) => prev + 1);
    }
  };

  const handleConfirmCsvImport = async () => {
    if (!csvImportState || isCsvImporting) return;
    setIsCsvImporting(true);
    const form = new FormData();
    form.append("file", csvImportState.file);
    try {
      const response = await fetch(`${API_BASE}/file/import-csv?replace=true`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail ?? `Could not import CSV (${response.status})`);
      }
      const summary = (await response.json()) as CsvImportSummary;
      if (summary.rows_imported === 0 && summary.rows_total > 0) {
        throw new Error(summary.errors[0]?.reason ?? "No CSV rows could be imported");
      }
      setCsvImportState(null);
      setUndoStack([]);
      await refreshAll();
      setToast({ message: `Imported ${summary.rows_imported} CSV rows`, showRevert: false });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Could not import CSV",
        showRevert: false,
      });
    } finally {
      setIsCsvImporting(false);
    }
  };

  const handleCancelCsvImport = () => {
    setCsvImportState(null);
  };

  const handleLoadCurriculum = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const courses = parseCurriculumCsv(text);
      setCurriculumPreview({ fileName: file.name, name: getFileBaseName(file.name), courses });
      const firstAvailableTerm = curriculumTerms.find((term) =>
        courses.some((course) => course.semester === term)
      );
      if (firstAvailableTerm) {
        setCurriculumTerm(firstAvailableTerm);
      }
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Could not load curriculum",
        showRevert: false,
      });
    }
    setCurriculumInputKey((prev) => prev + 1);
    setOpenMenu(null);
  };

  const handleConfirmCurriculumLoad = () => {
    if (!curriculumPreview) return;
    const name = curriculumPreview.name.trim() || getFileBaseName(curriculumPreview.fileName);
    const curriculum: Curriculum = {
      id: buildCurriculumId(),
      name,
      sourceFileName: curriculumPreview.fileName,
      importedAt: new Date().toISOString(),
      courses: curriculumPreview.courses,
    };
    setCurricula((prev) => [...prev, curriculum]);
    setCurriculumPreview(null);
    setToast({
      message: `Loaded ${curriculumPreview.courses.length} curriculum courses into ${name}`,
      showRevert: false,
    });
  };

  const handleClearCurriculum = () => {
    setCurricula([]);
    setCurriculumPreview(null);
    setYearLevelCurriculumIds({});
    localStorage.removeItem(CURRICULUM_STORAGE_KEY);
    localStorage.removeItem(CURRICULUM_STATE_STORAGE_KEY);
    localStorage.removeItem(CURRICULUM_STORAGE_VERSION_KEY);
    setToast({ message: "Curricula cleared", showRevert: false });
  };

  const handleRemoveCurriculum = (curriculumId: string) => {
    const curriculum = getCurriculumById(curriculumId);
    setCurricula((prev) => prev.filter((item) => item.id !== curriculumId));
    setYearLevelCurriculumIds((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([, assignedId]) => assignedId !== curriculumId)
      )
    );
    setToast({
      message: curriculum ? `Removed ${curriculum.name}` : "Curriculum removed",
      showRevert: false,
    });
  };

  const updateSectionYearLevel = (section: string, yearLevel: string) => {
    const sectionKey = normalizeMatchValue(section);
    if (!sectionKey) return;
    setSectionYearLevels((prev) => {
      const next = { ...prev };
      if (yearLevel) {
        next[sectionKey] = yearLevel;
      } else {
        delete next[sectionKey];
      }
      return next;
    });
  };

  const updateYearLevelCurriculum = (yearLevel: string, curriculumId: string) => {
    const yearLevelKey = normalizeMatchValue(yearLevel);
    if (!yearLevelKey) return;
    setYearLevelCurriculumIds((prev) => {
      const next = { ...prev };
      if (curriculumId) {
        next[yearLevelKey] = curriculumId;
      } else {
        delete next[yearLevelKey];
      }
      return next;
    });
  };

  const openEntityEditor = (kind: EntityEditorKind) => {
    const entities =
      kind === "section" ? sectionOptions : kind === "faculty" ? facultyOptions : roomOptions;
    setEntityEditorKind(kind);
    setEntityNameDrafts(Object.fromEntries(entities.map((entity) => [entity.id, entity.name])));
    setNewEntityName("");
    setForceEntityRemove(false);
    setEntityEditorError("");
    setOpenMenu(null);
    setIsEntityEditorOpen(true);
  };

  const applyEntityRenameLocally = (
    kind: EntityEditorKind,
    oldName: string,
    nextName: string
  ) => {
    const oldKey = normalizeMatchValue(oldName);
    setPaneSettings(prev => ({ ...prev,
      left: { ...prev.left, [kind]: normalizeMatchValue(prev.left[kind]) === oldKey ? nextName : prev.left[kind] },
      right: { ...prev.right, [kind]: normalizeMatchValue(prev.right[kind]) === oldKey ? nextName : prev.right[kind] },
    }));
    const nextKey = normalizeMatchValue(nextName);
    if (kind === "section") {
      setSectionYearLevels((prev) => {
        const next = { ...prev };
        if (next[oldKey]) {
          next[nextKey] = next[oldKey];
          delete next[oldKey];
        }
        return next;
      });
      setScheduleForm((prev) =>
        normalizeMatchValue(prev.Section) === oldKey ? { ...prev, Section: nextName } : prev
      );
      setSelectedSection((prev) => (normalizeMatchValue(prev) === oldKey ? nextName : prev));
      setSelectedSectionColor((prev) =>
        normalizeMatchValue(prev) === oldKey ? nextName : prev
      );
      setCustomizeSettings((prev) => {
        const nextColors = { ...prev.sectionBgColors };
        if (nextColors[oldName]) {
          nextColors[nextName] = nextColors[oldName];
          delete nextColors[oldName];
        }
        return { ...prev, sectionBgColors: nextColors };
      });
      return;
    }
    if (kind === "faculty") {
      setScheduleForm((prev) =>
        normalizeMatchValue(prev.Faculty) === oldKey ? { ...prev, Faculty: nextName } : prev
      );
      setSelectedFaculty((prev) => (normalizeMatchValue(prev) === oldKey ? nextName : prev));
      setSelectedFacultyColor((prev) =>
        normalizeMatchValue(prev) === oldKey ? nextName : prev
      );
      setCustomizeSettings((prev) => {
        const nextColors = { ...prev.facultyColors };
        if (nextColors[oldName]) {
          nextColors[nextName] = nextColors[oldName];
          delete nextColors[oldName];
        }
        return { ...prev, facultyColors: nextColors };
      });
      return;
    }
    setScheduleForm((prev) =>
      normalizeMatchValue(prev.Room) === oldKey ? { ...prev, Room: nextName } : prev
    );
    setSelectedRoom((prev) => (normalizeMatchValue(prev) === oldKey ? nextName : prev));
  };

  const applyEntityRemovalLocally = (kind: EntityEditorKind, name: string) => {
    const key = normalizeMatchValue(name);
    setPaneSettings(prev => ({ ...prev,
      left: { ...prev.left, [kind]: normalizeMatchValue(prev.left[kind]) === key ? "" : prev.left[kind] },
      right: { ...prev.right, [kind]: normalizeMatchValue(prev.right[kind]) === key ? "" : prev.right[kind] },
    }));
    if (kind === "section") {
      setSectionYearLevels((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSelectedSection((prev) => (normalizeMatchValue(prev) === key ? "" : prev));
      setSelectedSectionColor((prev) => (normalizeMatchValue(prev) === key ? "" : prev));
      setCustomizeSettings((prev) => {
        const nextColors = { ...prev.sectionBgColors };
        delete nextColors[name];
        return { ...prev, sectionBgColors: nextColors };
      });
      return;
    }
    if (kind === "faculty") {
      setSelectedFaculty((prev) => (normalizeMatchValue(prev) === key ? "" : prev));
      setSelectedFacultyColor((prev) => (normalizeMatchValue(prev) === key ? "" : prev));
      setCustomizeSettings((prev) => {
        const nextColors = { ...prev.facultyColors };
        delete nextColors[name];
        return { ...prev, facultyColors: nextColors };
      });
      return;
    }
    setSelectedRoom((prev) => (normalizeMatchValue(prev) === key ? "" : prev));
  };

  const handleRenameEntity = async (entity: NamedEntity) => {
    const nextName = (entityNameDrafts[entity.id] ?? entity.name).trim();
    if (!nextName) {
      setEntityEditorError(`${entityEditorConfig.label} name cannot be blank.`);
      return;
    }
    if (nextName === entity.name) return;
    const duplicate = entityEditorConfig.entities.find(
      (item) =>
        item.id !== entity.id && normalizeMatchValue(item.name) === normalizeMatchValue(nextName)
    );
    const canMerge =
      Boolean(duplicate) &&
      (entityEditorConfig.kind === "faculty" || entityEditorConfig.kind === "room");
    if (duplicate && !canMerge) {
      setEntityEditorError(`${entityEditorConfig.label} already exists.`);
      return;
    }
    const shouldMerge =
      canMerge &&
      window.confirm(
        `${entityEditorConfig.label} "${nextName}" already exists. Merge "${entity.name}" into "${duplicate?.name}"?`
      );
    if (canMerge && !shouldMerge) return;
    const url = new URL(`${API_BASE}/${entityEditorConfig.path}/${entity.id}`);
    if (shouldMerge) {
      url.searchParams.set("merge", "true");
    }
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: duplicate?.name ?? nextName }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setEntityEditorError(body?.detail ?? `Could not rename ${entityEditorConfig.label.toLowerCase()}.`);
      return;
    }
    applyEntityRenameLocally(entityEditorConfig.kind, entity.name, duplicate?.name ?? nextName);
    setEntityNameDrafts((prev) => {
      const next = { ...prev };
      if (shouldMerge) {
        delete next[entity.id];
      } else {
        next[entity.id] = nextName;
      }
      return next;
    });
    await refreshAll();
  };

  const handleAddEntity = async () => {
    const name = newEntityName.trim();
    if (!name) {
      setEntityEditorError(`${entityEditorConfig.label} name cannot be blank.`);
      return;
    }
    setEntityEditorError("");
    const response = await fetch(`${API_BASE}/${entityEditorConfig.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setEntityEditorError(body?.detail ?? `Could not add ${entityEditorConfig.label.toLowerCase()}.`);
      return;
    }
    const created = (await response.json()) as NamedEntity;
    setEntityNameDrafts((prev) => ({ ...prev, [created.id]: created.name }));
    setNewEntityName("");
    await refreshAll();
  };

  const deleteScheduleEntriesForEntity = async (entity: NamedEntity) => {
    const params = new URLSearchParams();
    if (entityEditorConfig.kind === "section") {
      params.set("section", entity.name);
    } else if (entityEditorConfig.kind === "faculty") {
      params.set("faculty", entity.name);
    } else {
      params.set("room", entity.name);
    }
    const entriesResponse = await fetch(`${API_BASE}/schedule?${params.toString()}`);
    if (!entriesResponse.ok) {
      throw new Error("Could not load related classes.");
    }
    const relatedEntries = (await entriesResponse.json()) as ScheduleEntry[];
    for (const entry of relatedEntries) {
      const deleteResponse = await fetch(`${API_BASE}/schedule/${entry.id}`, {
        method: "DELETE",
      });
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error("Could not remove every related class.");
      }
    }
  };

  const handleDeleteEntity = async (entity: NamedEntity) => {
    setEntityEditorError("");
    if (forceEntityRemove) {
      try {
        await deleteScheduleEntriesForEntity(entity);
      } catch (error) {
        setEntityEditorError(
          error instanceof Error ? error.message : "Could not remove related classes."
        );
        return;
      }
    }
    const removeEntity = async (base: string) => {
      const removeUrl = new URL(`${base}/${entityEditorConfig.path}/${entity.id}/remove`);
      if (forceEntityRemove) {
        removeUrl.searchParams.set("force", "true");
      }
      const removeResponse = await fetch(removeUrl.toString(), { method: "POST" });
      if (removeResponse.status !== 405) {
        return removeResponse;
      }
      const deleteUrl = new URL(`${base}/${entityEditorConfig.path}/${entity.id}`);
      if (forceEntityRemove) {
        deleteUrl.searchParams.set("force", "true");
      }
      return fetch(deleteUrl.toString(), { method: "DELETE" });
    };
    let response = await removeEntity(API_BASE);
    if (response.status === 405) {
      try {
        response = await removeEntity(API_FALLBACK_BASE);
      } catch {
        setEntityEditorError(
          "The backend currently running does not support faculty/room removal. Restart the backend, then try again."
        );
        return;
      }
      if (response.status === 405) {
        setEntityEditorError(
          "The backend currently running does not support faculty/room removal. Restart the backend, then try again."
        );
        return;
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setEntityEditorError(body?.detail ?? `Could not delete ${entityEditorConfig.label.toLowerCase()}.`);
      return;
    }
    applyEntityRemovalLocally(entityEditorConfig.kind, entity.name);
    setEntityNameDrafts((prev) => {
      const next = { ...prev };
      delete next[entity.id];
      return next;
    });
    setEntityEditorError("");
    await refreshAll();
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

  const updateClassBlockFontSize = (value: number) => {
    const nextValue = Math.min(24, Math.max(8, value));
    setCustomizeSettings((prev) => ({
      ...prev,
      classBlockFontSizePx: nextValue,
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

  const exportFacultyLoad = (facultyNames: string[]) => {
    const escapeHtml = (value: unknown) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    const formatLoadNumber = (value: number) => {
      const rounded = roundHours(value);
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "");
    };
    const reportSections = facultyNames.map((facultyName) => {
      const facultyEntries = entries
        .filter((entry) => normalizeMatchValue(entry.Faculty) === normalizeMatchValue(facultyName))
        .sort((left, right) =>
          [left["Course Code"], left.Section, left.Days, left["Time (24 Hrs)"] ?? ""].join("|").localeCompare(
            [right["Course Code"], right.Section, right.Days, right["Time (24 Hrs)"] ?? ""].join("|"),
            undefined,
            { sensitivity: "base", numeric: true }
          )
        );
      const countedAssignments = new Set<string>();
      let lectureHours = 0;
      let laboratoryHours = 0;
      let lectureUnits = 0;
      let laboratoryUnits = 0;
      const rows = facultyEntries.map((entry) => {
        const curriculumCourse = getCurriculumCourse(entry["Course Code"], entry.Section);
        const isLaboratory = curriculumCourse
          ? curriculumCourse.labUnits > 0
          : /\blab(?:oratory)?\b/i.test(`${entry["Course Code"]} ${entry["Course Description"]}`);
        const kind = isLaboratory ? "LAB" : "LEC";
        const hours = getEntryWeeklyHours(entry);
        const units = curriculumCourse?.totalUnits ?? entry.Units;
        const assignmentKey = `${normalizeMatchValue(entry.Section)}|${normalizeMatchValue(entry["Course Code"])}`;
        const isFirstAssignmentRow = !countedAssignments.has(assignmentKey);
        if (isFirstAssignmentRow) {
          countedAssignments.add(assignmentKey);
          if (isLaboratory) laboratoryUnits += units;
          else lectureUnits += units;
        }
        if (isLaboratory) laboratoryHours += hours;
        else lectureHours += hours;
        return `<tr><td>${escapeHtml(entry["Course Code"])}</td><td>${escapeHtml(entry.Section)}</td><td>${escapeHtml(entry.Days)} ${escapeHtml(entry["Time (LPU Std)"])}</td><td>${escapeHtml(entry.Room)}</td><td class="number">${formatLoadNumber(hours)}</td><td class="number">${isFirstAssignmentRow ? formatLoadNumber(units) : "&mdash;"}</td><td>${kind}</td></tr>`;
      });
      const totalHours = lectureHours + laboratoryHours;
      const totalUnits = lectureUnits + laboratoryUnits;
      const bodyRows = rows.length ? rows.join("") : '<tr><td colspan="7" class="empty">No scheduled classes.</td></tr>';
      return `<section class="faculty-report"><h1>Faculty Load</h1><div class="summary"><div class="faculty"><strong>Faculty Name:</strong> ${escapeHtml(facultyName)}</div><div><strong>Total Number of Hours:</strong> ${formatLoadNumber(totalHours)}</div><div><strong>Total Number of Units:</strong> ${formatLoadNumber(totalUnits)}</div><div><strong>Hours Lecture:</strong> ${formatLoadNumber(lectureHours)}</div><div><strong>Units Lecture:</strong> ${formatLoadNumber(lectureUnits)}</div><div><strong>Hours Laboratory:</strong> ${formatLoadNumber(laboratoryHours)}</div><div><strong>Units Laboratory:</strong> ${formatLoadNumber(laboratoryUnits)}</div></div><table><thead><tr><th>Course Code</th><th>Section</th><th>Time</th><th>Room</th><th>Number of Hours</th><th># of Units</th><th>LEC/LAB</th></tr></thead><tbody>${bodyRows}</tbody></table></section>`;
    });
    const report = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Faculty Loads</title><style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0;color:#111;font-family:Arial,sans-serif;font-size:11pt}.faculty-report{break-after:page}.faculty-report:last-child{break-after:auto}h1{margin:0 0 20px;text-align:center;font-size:18pt}.summary{margin-bottom:20px;line-height:1.6}.faculty{font-size:13pt}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:7px 8px;text-align:left;vertical-align:top}th{background:#e9eef5;font-weight:700}.number{text-align:right}.empty{padding:22px;text-align:center;color:#555}@media print{h1,.summary,thead{break-after:avoid}tr{break-inside:avoid}}</style></head><body>${reportSections.join("")}</body></html>`;
    const filename = facultyNames.length === 1
      ? `faculty-load-${facultyNames[0].replace(/[^a-z0-9_-]+/gi, "_")}.html`
      : "faculty-loads.html";
    downloadBlob(new Blob([report], { type: "text/html;charset=utf-8" }), filename);
    setIsFacultyLoadExportOpen(false);
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

  const isTimetableView = viewMode.startsWith("timetable");
  const effectiveSelection =
    currentViewConfig.selected || currentViewConfig.entities[0]?.name || "";
  const showStartPage =
    entries.length === 0 &&
    (sections.length === 0 || (isTimetableView && currentViewConfig.entities.length === 0));
  const canExportTimetable =
    isTimetableView && Boolean(effectiveSelection) && currentViewConfig.entities.length > 0;
  const facultyLoadHours = useMemo(() => {
    const loads: Record<string, number> = {};
    entries.forEach((entry) => {
      const key = normalizeMatchValue(entry.Faculty);
      if (!key) return;
      loads[key] = (loads[key] ?? 0) + getEntryWeeklyHours(entry);
    });
    return loads;
  }, [entries]);
  const formatHoursLabel = (hours: number) => {
    const rounded = roundHours(hours);
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  };
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
  const openAddClass = (id: PaneId) => {
    if (isSaving) return;
    activatePane(id);
    const pane = paneSettings[id];
    const assignment = assignmentForPane(pane);
    const defaults = { ...buildEmptyScheduleForm({ Program: scheduleForm.Program }),
      [assignment.kind === "section" ? "Section" : assignment.kind === "faculty" ? "Faculty" : "Room"]: assignment.name };
    if (selectionPaneId === id && selectionRange) {
      defaults.Days = selectionRange.day;
      defaults["Time (LPU Std)"] = toLpuLabel(selectionRange.startMinutes, selectionRange.endMinutes);
      defaults["Time (24 Hrs)"] = toTimeRange24(selectionRange.startMinutes, selectionRange.endMinutes);
    }
    setFormEditId(null); setFormError(""); setSelectedEntryId(null); setScheduleForm(defaults);
    editorBaseline.current = draftFingerprint(defaults); setEditorOpen(true);
  };
  const resizeDivider = (clientX: number) => {
    const bounds = splitContainerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width < 848) return;
    const width = bounds.width - 8;
    const ratio = Math.max(420 / width, Math.min(1 - 420 / width, (clientX - bounds.left) / width));
    setPaneSettings(prev => ({ ...prev, ratio }));
  };
  const handlePaneScroll = (id: PaneId, element: HTMLDivElement) => {
    const otherId = id === "left" ? "right" : "left";
    const other = (otherId === "left" ? leftTimetableRef : rightTimetableRef).current;
    const grid = element.querySelector<HTMLElement>(".timetable-grid");
    const gridOffset = grid ? grid.offsetTop : 0;
    const top = element.scrollTop;
    if (scrollSyncRef.current === id) {
      scrollSyncRef.current = null;
      updatePane(id, { scrollTop: top, scrollLeft: element.scrollLeft });
      return;
    }
    updatePane(id, { scrollTop: top, scrollLeft: element.scrollLeft });
    if (!wideSplit || !paneSettings.linked || !other || isExporting) return;
    const otherGrid = other.querySelector<HTMLElement>(".timetable-grid");
    const otherOffset = otherGrid ? otherGrid.offsetTop : 0;
    const target = Math.max(0, otherOffset + linkedScrollTop(top - gridOffset, paneSettings[id].zoom, paneSettings[otherId].zoom));
    if (Math.abs(other.scrollTop - target) > 1) {
      scrollSyncRef.current = otherId;
      other.scrollTop = target;
    }
  };
  const applyPaneZoom = (id: PaneId, next: number) => {
    const zoom = Math.max(zoomMin, Math.min(zoomMax, next));
    const element = (id === "left" ? leftTimetableRef : rightTimetableRef).current;
    const grid = element?.querySelector<HTMLElement>(".timetable-grid");
    const offset = grid ? grid.offsetTop : 0;
    const scrollTop = Math.max(0, offset + linkedScrollTop((element?.scrollTop ?? 0) - offset, paneSettings[id].zoom, zoom));
    updatePane(id, { zoom, scrollTop });
    requestAnimationFrame(() => { if (element) element.scrollTop = scrollTop; });
  };
  const renderTimetable = (id: PaneId, exportPane?: PaneState) => {
    const capture = Boolean(exportPane);
    const pane = exportPane ?? paneSettings[id];
    const viewMode = pane.mode;
    const kind = paneField(viewMode);
    const entities = kind === "section" ? sectionOptions : kind === "faculty" ? facultyOptions : roomOptions;
    const effectiveSelection = pane[kind] || entities[0]?.name || "";
    const currentViewConfig = { selected: effectiveSelection, entities, label: kind, setSelected: (name: string) => { activatePane(id); updatePane(id, { [kind]: name }); } };
    const currentSectionBg = kind === "section" ? customizeSettings.sectionBgColors[effectiveSelection] : undefined;
    const field = kind === "section" ? "Section" : kind === "faculty" ? "Faculty" : "Room";
    const timetableEntries = entries.filter(entry => entry[field] === effectiveSelection);
    const paneSelectionRange = !capture && selectionPaneId === id ? selectionRange : null;
    const zoomPercent = pane.zoom;
    const rowHeight = `${40 * zoomPercent / 100}px`;
    const fontSize = `${12 * zoomPercent / 100}px`;
    const blockPadding = `${6 * zoomPercent / 100}px`;
    const blockFontSize = `${customizeSettings.classBlockFontSizePx * zoomPercent / 100}px`;
    const hasMultipleEntities = entities.length > 1;
    const index = entities.findIndex(entity => entity.name === effectiveSelection);
    const prevEntity = () => currentViewConfig.setSelected(entities[(index - 1 + entities.length) % entities.length].name);
    const nextEntity = () => currentViewConfig.setSelected(entities[(index + 1) % entities.length].name);
    const getTimetableEntityLabel = (name: string) => kind === "faculty" && name ? `${name} (${formatHoursLabel(facultyLoadHours[normalizeMatchValue(name)] ?? 0)} hrs)` : name;
    const scrollRef = capture ? captureTimetableRef : id === "left" ? leftTimetableRef : rightTimetableRef;
    return (
    <TimetablePane key={capture ? "capture" : id} id={id} pane={pane} split={splitMode} active={!capture && activePaneId === id} capture={capture} ready={entities.length > 0}
      scrollRef={scrollRef} onActivate={() => { if (!capture) activatePane(id); }}
      onMode={mode => updatePane(id, { mode })} onAdd={() => openAddClass(id)}
      onScroll={event => { if (!capture) handlePaneScroll(id, event.currentTarget); }}
      onContextMenu={event => { if (!capture) handleContextMenu(event, id); }}
      onMouseUp={() => { if (selectionPaneId === id) finalizeSelection(); }} background={currentSectionBg}>
              <div className="timetable-header">
                <div className="timetable-header-left">
                  <button
                    className="nav-button"
                    onClick={prevEntity}
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
                        {getTimetableEntityLabel(entity.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="timetable-title">
                  {getTimetableEntityLabel(effectiveSelection) ||
                    (currentViewConfig.label ? `No ${currentViewConfig.label} yet` : "")}
                </div>
                <div className="timetable-header-right">
                  <div className="zoom-controls">
                    <button
                      className="nav-button"
                      onClick={() => applyPaneZoom(id, zoomPercent - zoomStep)}
                      disabled={zoomPercent <= zoomMin}
                    >
                      -
                    </button>
                    <button className="nav-button" onClick={() => applyPaneZoom(id, 100)}>
                      Reset
                    </button>
                    <button
                      className="nav-button"
                      onClick={() => applyPaneZoom(id, zoomPercent + zoomStep)}
                      disabled={zoomPercent >= zoomMax}
                    >
                      +
                    </button>
                  </div>
                  <button
                    className="nav-button"
                    onClick={nextEntity}
                    disabled={!hasMultipleEntities}
                  >
                    ▶
                  </button>
                </div>
              </div>
              {!capture && activePaneId === id && toast && toast.showRevert && (
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
                      gridTemplateColumns: `${splitMode && !capture ? 72 : 120}px repeat(${visibleDays.length}, minmax(90px, 1fr))`,
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
                      handleDrop(id);
                    }}
                    style={{
                      gridTemplateColumns: `${splitMode && !capture ? 72 : 120}px repeat(${visibleDays.length}, minmax(90px, 1fr))`,
                      gridTemplateRows: `repeat(${slots.length}, var(--row-height))`,
                      ["--row-height" as string]: rowHeight,
                      ["--font-size" as string]: fontSize,
                      ["--block-font-size" as string]: blockFontSize,
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
                            paneSelectionRange &&
                            paneSelectionRange.day === day &&
                            slot >= paneSelectionRange.startMinutes &&
                            slot < paneSelectionRange.endMinutes
                              ? "selected"
                              : ""
                          }`}
                          style={{ gridColumn: dayIndex + 2, gridRow: rowIndex + 1 }}
                          onMouseDown={(event) => handleSelectStart(event, day, rowIndex, id)}
                          onMouseEnter={() => { if (selectionPaneId === id) handleSelectMove(day, rowIndex); }}
                          onMouseUp={() => { if (selectionPaneId === id) finalizeSelection(); }}
                          onDragOver={(event) => handleDragOver(event, day, slot, id)}
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
                      const foundEndIndex = slots.findIndex((slot) => slot >= end);
                      const endIndex = Math.max(startIndex + 1, foundEndIndex < 0 ? slots.length : foundEndIndex);
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
                              className={`block ${conflictSet.has(entry.id) ? "conflict" : ""} ${
                                !capture && selectedEntryId === entry.id ? "selected" : ""
                              }`}
                              style={{
                                gridColumn: column,
                                gridRow: `${startIndex + 1} / ${Math.max(endIndex, startIndex + 1) + 1}`,
                                backgroundColor: blockBg,
                                color: textColor,
                              }}
                              draggable={!capture && !isSaving && !editorOpen && !isExporting}
                              tabIndex={capture ? undefined : 0}
                              role="button"
                              data-entry-id={entry.id}
                              aria-label={`Edit ${entry["Course Code"]}, ${entry.Section}, ${day}`}
                              onKeyDown={event => { if (!capture && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); enterEditMode(entry); } }}
                              onDragStart={() => handleDragStart(entry, day, id)}
                              onDragOver={event => {
                                const offset = event.clientY - event.currentTarget.getBoundingClientRect().top;
                                const row = Math.floor(offset / (40 * pane.zoom / 100));
                                handleDragOver(event, day, slots[startIndex] + row * interval, id);
                              }}
                              onDragEnd={() => {
                                setDragging(null);
                                setDragTarget(null);
                              }}
                              onClick={() => { if (!capture) enterEditMode(entry); }}
                              onContextMenu={(event) => handleBlockContextMenu(event, entry, day, id)}
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
                    {!capture && dragging && dragTarget && dragTarget.paneId === id && (
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
                        <div>{assignmentForPane(pane).name}</div>
                        <div>{dayLabels[dragTarget.day]} {toLpuLabel(dragTarget.startMinutes, dragTarget.startMinutes + dragging.duration)}</div>
                      </div>
                    )}
                  </div>
                </>
              )}
              {!capture && contextMenu && contextMenu.paneId === id && (
                <div
                  className="context-menu"
                  style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                  <button onClick={applySelectionToForm}>Add Class</button>
                  {viewMode === "timetable-section" && copiedBlock ? (
                    <button onClick={pasteCopiedBlockToCurrentSection} disabled={isSaving}>
                      Paste Copied Class
                    </button>
                  ) : null}
                </div>
              )}
              {!capture && blockMenu && blockMenu.paneId === id && (
                <div
                  className="block-menu"
                  style={{ top: blockMenu.y, left: blockMenu.x }}
                >
                  <button onClick={() => enterEditMode(blockMenu.entry)} disabled={isSaving}>
                    Edit
                  </button>
                  <button onClick={copyBlock} disabled={isSaving}>
                    Copy
                  </button>
                  <button
                    onClick={() => duplicateEntryToNextDay(blockMenu.entry, blockMenu.day)}
                    disabled={isSaving}
                  >
                    Duplicate to Next Day
                  </button>
                  <button onClick={() => deleteEntry(blockMenu.entry)} disabled={isSaving}>
                    Delete
                  </button>
                </div>
              )}
    </TimetablePane>
    );
  };
  const renderClassForm = () => <>
          {!splitMode && formEditId && (
            <div className="edit-mode-banner">
              <div>
                <strong>Editing selected class</strong>
                <span>
                  {scheduleForm["Course Code"] || "Untitled class"} /{" "}
                  {scheduleForm.Section || "No section"}
                </span>
              </div>
              <button
                className="secondary-button compact-button"
                onClick={cancelEditMode}
                disabled={isSaving}
              >
                Cancel
              </button>
            </div>
          )}
          <h3>{formEditId ? "Edit Class" : "Add Class"}</h3>
          {activeCurriculumCourses.length > 0 ? (
            <div className="form-note">
              Curriculum: {curriculumTerm}
              {formSectionYearLevel ? ` / ${formSectionYearLevel}` : ""}
              {formSectionYearLevel && getYearLevelCurriculum(formSectionYearLevel)
                ? ` / ${getYearLevelCurriculum(formSectionYearLevel)?.name}`
                : ""} (
              {getCurriculumCoursesForSection(scheduleForm.Section).length} courses)
            </div>
          ) : null}
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
          <label className="course-code-field">
            Course Code
            <input
              ref={courseCodeRef}
              className={selectedCoursePlotStatus.isComplete ? "course-code-complete" : ""}
              value={scheduleForm["Course Code"]}
              onChange={(event) => {
                applyCourseCodeToScheduleForm(event.target.value);
                openCourseCodeMenu();
              }}
              onFocus={openCourseCodeMenu}
              onClick={openCourseCodeMenu}
              onBlur={() => window.setTimeout(() => setIsCourseCodeMenuOpen(false), 120)}
              autoComplete="off"
            />
            {scheduleForm["Course Code"] ? (
              <div
                className={`course-plot-status ${
                  selectedCoursePlotStatus.isComplete ? "complete" : ""
                }`}
              >
                {selectedCoursePlotStatus.requiredHours !== null
                  ? `${formatHoursLabel(selectedCoursePlotStatus.plottedHours)} / ${formatHoursLabel(
                      selectedCoursePlotStatus.requiredHours
                    )} hrs plotted`
                  : `${formatHoursLabel(selectedCoursePlotStatus.plottedHours)} hrs plotted`}
              </div>
            ) : null}
            {isCourseCodeMenuOpen && visibleCourseCodeOptions.length > 0 ? (
              <div className="course-code-menu-left" style={courseCodeMenuPosition}>
                {visibleCourseCodeOptions.map((courseCode) => {
                  const status = getCoursePlotStatus(courseCode, scheduleForm.Section, null);
                  return (
                    <button
                      key={courseCode}
                      type="button"
                      className={status.isComplete ? "complete" : ""}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyCourseCodeToScheduleForm(courseCode);
                        setIsCourseCodeMenuOpen(false);
                      }}
                      onClick={() => {
                        applyCourseCodeToScheduleForm(courseCode);
                        setIsCourseCodeMenuOpen(false);
                      }}
                    >
                      <span>{courseCode}</span>
                      <span>{getCourseCodeOptionLabel(courseCode)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <datalist id="course-code-list">
              {formCourseCodeOptions.map((courseCode) => (
                <option
                  key={courseCode}
                  value={courseCode}
                  label={getCourseCodeOptionLabel(courseCode)}
                />
              ))}
            </datalist>
          </label>
          <label>
            Course Description
            <input
              value={scheduleForm["Course Description"]}
              readOnly={Boolean(getCanonicalCourseDescription(scheduleForm["Course Code"]))}
              onChange={(event) => {
                const canonical = getCanonicalCourseDescription(scheduleForm["Course Code"]);
                setScheduleForm({
                  ...scheduleForm,
                  "Course Description": canonical || event.target.value,
                });
              }}
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
              readOnly
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
          {!splitMode && <button onClick={handleCreateSchedule} disabled={isSaving}>
            {formEditId ? "Save Changes to Selected Class" : "Add Class"}
          </button>}
          {!splitMode && formEditId && (
            <button className="secondary-button" onClick={cancelEditMode} disabled={isSaving}>
              Cancel Edit
            </button>
          )}
          {formError && <p className="error">{formError}</p>}

  </>;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (editorOpen || isSaving || isExporting || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault(); void handleUndo();
      } else if (key === "c") {
        const id = Number(target?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId ?? selectedEntryId);
        const entry = entries.find(row => row.id === id);
        if (entry) {
          event.preventDefault(); setCopiedBlock(entry);
          setToast({ message: `Copied ${entry["Course Code"]} from ${entry.Section}`, showRevert: false });
        }
      } else if (key === "v" && copiedBlock && isTimetableView) {
        event.preventDefault(); void pasteCopiedBlockToCurrentSection();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!wideSplit || !paneSettings.linked || !scheduleLoaded) return;
    const element = timetableRef.current;
    if (element) handlePaneScroll(activePaneId, element);
  }, [wideSplit, paneSettings.linked, scheduleLoaded]);

  return (
    <div className="app">
      {toast && !toast.showRevert && (
        <div className="toast global" role="status" aria-live="polite">
          <span>{toast.message}</span>
        </div>
      )}
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
                      key={dbInputKey}
                      type="file"
                      accept=".db,.sqlite,.sqlite3,application/x-sqlite3"
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
                  <div className="menu-divider" />
                  <label className="menu-item file-input">
                    Load Curriculum
                    <input
                      key={curriculumInputKey}
                      type="file"
                      accept=".csv"
                      onChange={handleLoadCurriculum}
                    />
                  </label>
                  {curricula.length > 0 ? (
                    <>
                      <label className="menu-checkbox menu-select">
                        Semester
                        <select
                          value={curriculumTerm}
                          onChange={(event) =>
                            setCurriculumTerm(event.target.value as CurriculumTerm)
                          }
                        >
                          {curriculumTerms.map((term) => (
                            <option key={term} value={term}>
                              {term}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="menu-item"
                        onClick={() => {
                          handleClearCurriculum();
                          setOpenMenu(null);
                        }}
                        type="button"
                      >
                        Clear Curricula
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="menu-group">
              <button
                className="menu-button"
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0 || isSaving}
              >
                Undo
              </button>
            </div>
            <div className="menu-group">
              <button
                className={`menu-button ${openMenu === "edit" ? "active" : ""}`}
                onClick={() => setOpenMenu((prev) => (prev === "edit" ? null : "edit"))}
                type="button"
              >
                Edit ▼
              </button>
              {openMenu === "edit" ? (
                <div className="menu-dropdown" role="menu">
                  <button
                    className="menu-item"
                    onClick={() => openEntityEditor("section")}
                    type="button"
                  >
                    Edit Section
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => openEntityEditor("faculty")}
                    type="button"
                  >
                    Edit Faculty
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => openEntityEditor("room")}
                    type="button"
                  >
                    Edit Room
                  </button>
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
                  <button
                    className="menu-item"
                    onClick={() => {
                      setFacultyLoadExportNames(
                        viewMode === "timetable-faculty" && effectiveSelection
                          ? [effectiveSelection]
                          : []
                      );
                      setIsFacultyLoadExportOpen(true);
                      setOpenMenu(null);
                    }}
                    disabled={facultyOptions.length === 0}
                    type="button"
                  >
                    Export Faculty Load
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
                      <label className="menu-checkbox">
                        <input
                          type="checkbox"
                          checked={exportSections}
                          onChange={(event) => setExportSections(event.target.checked)}
                        />
                        By Section
                      </label>
                      <label className="menu-checkbox">
                        <input
                          type="checkbox"
                          checked={exportFaculty}
                          onChange={(event) => setExportFaculty(event.target.checked)}
                        />
                        By Faculty
                      </label>
                      <label className="menu-checkbox">
                        <input
                          type="checkbox"
                          checked={exportRooms}
                          onChange={(event) => setExportRooms(event.target.checked)}
                        />
                        By Room
                      </label>
                      <button
                        className="menu-item"
                        type="button"
                        disabled={isExporting || (!exportSections && !exportFaculty && !exportRooms)}
                        onClick={() => {
                          setOpenMenu(null);
                          setOpenExportSubmenu(false);
                          exportBatch();
                        }}
                      >
                        Start Mass Export
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
            <button type="button" className={!splitMode ? "active" : ""} disabled={editorOpen || isSaving} onClick={() => setPaneSettings(prev => ({ ...prev, split: false }))}>Single View</button>
            <button type="button" className={splitMode ? "active" : ""} disabled={editorOpen || isSaving} onClick={() => { setIsTextView(false); setPaneSettings(prev => ({ ...prev, split: true })); }}>Split View</button>
            <button
              className={viewMode === "text" ? "active" : ""}
              disabled={editorOpen || isSaving} onClick={() => setViewMode("text")}
              type="button"
            >
              Text View
            </button>
            <button
              className={viewMode === "timetable-section" ? "active" : ""}
              disabled={editorOpen || isSaving} onClick={() => setViewMode("timetable-section")}
              type="button"
            >
              Timetable: Per Section
            </button>
            <button
              className={viewMode === "timetable-faculty" ? "active" : ""}
              disabled={editorOpen || isSaving} onClick={() => setViewMode("timetable-faculty")}
              type="button"
            >
              Timetable: Per Faculty
            </button>
            <button
              className={viewMode === "timetable-room" ? "active" : ""}
              disabled={editorOpen || isSaving} onClick={() => setViewMode("timetable-room")}
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
      {isFacultyLoadExportOpen ? (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Export Faculty Load</h3>
            <label className="menu-checkbox">
              <input
                type="checkbox"
                checked={facultyLoadExportNames.length === facultyOptions.length}
                onChange={(event) =>
                  setFacultyLoadExportNames(
                    event.target.checked ? facultyOptions.map((member) => member.name) : []
                  )
                }
              />
              Select All Faculty
            </label>
            <div className="faculty-export-list">
              {facultyOptions.map((member) => (
                <label key={member.id} className="menu-checkbox">
                  <input
                    type="checkbox"
                    checked={facultyLoadExportNames.includes(member.name)}
                    onChange={(event) =>
                      setFacultyLoadExportNames((current) =>
                        event.target.checked
                          ? [...current, member.name]
                          : current.filter((name) => name !== member.name)
                      )
                    }
                  />
                  {member.name}
                </label>
              ))}
            </div>
            <div className="modal-note">
              Units come from the loaded curriculum. Split schedule rows for the same course and
              section count their units once; their scheduled hours are added together.
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setIsFacultyLoadExportOpen(false)}>Cancel</button>
              <button type="button" disabled={facultyLoadExportNames.length === 0} onClick={() => exportFacultyLoad(facultyLoadExportNames)}>
                Export Selected ({facultyLoadExportNames.length})
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {curriculumPreview ? (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Load Curriculum</h3>
            <p>
              {curriculumPreview.fileName} contains{" "}
              <strong>{curriculumPreview.courses.length}</strong> courses.
            </p>
            <label className="modal-field">
              Name
              <input
                value={curriculumPreview.name}
                onChange={(event) =>
                  setCurriculumPreview((prev) =>
                    prev ? { ...prev, name: event.target.value } : prev
                  )
                }
              />
            </label>
            <label className="modal-field">
              Semester
              <select
                value={curriculumTerm}
                onChange={(event) => setCurriculumTerm(event.target.value as CurriculumTerm)}
              >
                {curriculumTerms.map((term) => {
                  const count = curriculumPreview.courses.filter(
                    (course) => course.semester === term
                  ).length;
                  return (
                    <option key={term} value={term}>
                      {term} ({count})
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="modal-note">
              Hours use curriculum units: lecture units count as 1 hour in first/second
              semester, lab units count as 3 hours, and term break lecture units count as
              4.25 hours.
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setCurriculumPreview(null)}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmCurriculumLoad}>
                Load
              </button>
            </div>
          </div>
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
      {isEntityEditorOpen ? (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <h3>Edit {entityEditorConfig.label}</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setIsEntityEditorOpen(false)}
              >
                x
              </button>
            </div>
            {entityEditorConfig.kind === "section" && curricula.length > 0 ? (
              <div className="entity-editor-panel">
                <h4>Curricula</h4>
                <div className="curriculum-editor-list">
                  {curricula.map((curriculum) => (
                    <div key={curriculum.id} className="curriculum-editor-row">
                      <span>
                        {curriculum.name} ({curriculum.courses.length} courses)
                      </span>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => handleRemoveCurriculum(curriculum.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                {curriculumYearLevels.length > 0 ? (
                  <div className="year-curriculum-list">
                    {curriculumYearLevels.map((yearLevel) => (
                      <label key={yearLevel} className="year-curriculum-row">
                        {yearLevel}
                        <select
                          value={getYearLevelCurriculumId(yearLevel)}
                          onChange={(event) =>
                            updateYearLevelCurriculum(yearLevel, event.target.value)
                          }
                        >
                          <option value="">All curricula</option>
                          {curricula.map((curriculum) => (
                            <option key={curriculum.id} value={curriculum.id}>
                              {curriculum.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <label className="force-remove-option">
              <input
                type="checkbox"
                checked={forceEntityRemove}
                onChange={(event) => setForceEntityRemove(event.target.checked)}
              />
              Forcefully remove {entityEditorConfig.label.toLowerCase()} and related classes
            </label>
            <div className="entity-add-row">
              <input
                value={newEntityName}
                onChange={(event) => setNewEntityName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleAddEntity();
                  }
                }}
                placeholder={`New ${entityEditorConfig.label.toLowerCase()} name`}
              />
              <button type="button" onClick={handleAddEntity}>
                Add
              </button>
            </div>
            {entityEditorConfig.entities.length === 0 ? (
              <p>No {entityEditorConfig.pluralLabel} yet.</p>
            ) : (
              <div className="entity-editor-list">
                {entityEditorConfig.entities.map((entity) => (
                  <div
                    key={entity.id}
                    className={`entity-editor-row ${
                      entityEditorConfig.kind === "section" ? "" : "simple"
                    }`}
                  >
                    <input
                      value={entityNameDrafts[entity.id] ?? entity.name}
                      onChange={(event) =>
                        setEntityNameDrafts((prev) => ({
                          ...prev,
                          [entity.id]: event.target.value,
                        }))
                      }
                    />
                    {entityEditorConfig.kind === "section" ? (
                      <select
                        value={getSectionYearLevel(entity.name)}
                        onChange={(event) =>
                          updateSectionYearLevel(entity.name, event.target.value)
                        }
                        disabled={curriculumYearLevels.length === 0}
                      >
                        <option value="">All year levels</option>
                        {curriculumYearLevels.map((yearLevel) => (
                          <option key={yearLevel} value={yearLevel}>
                            {yearLevel}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button type="button" onClick={() => handleRenameEntity(entity)}>
                      Rename
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => handleDeleteEntity(entity)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {entityEditorError ? <p className="error">{entityEditorError}</p> : null}
            <div className="modal-actions">
              <button type="button" onClick={() => setIsEntityEditorOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {activeCourseDescriptionConflicts.length > 0 ? (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <h3>Course Description Match</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setCourseDescriptionPromptDismissedFor(courseDescriptionConflictSignature)
                }
              >
                x
              </button>
            </div>
            <p>Select the description to use for each course code.</p>
            <div className="course-description-list">
              {activeCourseDescriptionConflicts.map((conflict) => (
                <label key={conflict.codeKey} className="course-description-choice">
                  <span>{conflict.code}</span>
                  <select
                    value={
                      courseDescriptionSelections[conflict.codeKey] ??
                      courseDescriptionCatalog.canonicalDescriptions[conflict.codeKey] ??
                      conflict.descriptions[0]
                    }
                    onChange={(event) =>
                      setCourseDescriptionSelections((prev) => ({
                        ...prev,
                        [conflict.codeKey]: event.target.value,
                      }))
                    }
                  >
                    {conflict.descriptions.map((description) => (
                      <option key={description} value={description}>
                        {description} ({conflict.entryIdsByDescription[description]?.length ?? 0})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() =>
                  setCourseDescriptionPromptDismissedFor(courseDescriptionConflictSignature)
                }
                disabled={isCourseDescriptionFixing}
              >
                Later
              </button>
              <button
                type="button"
                onClick={applyCourseDescriptionFixes}
                disabled={isCourseDescriptionFixing}
              >
                {isCourseDescriptionFixing ? "Updating..." : "Apply"}
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
              <label className="menu-checkbox">
                <span>Class block font size (px)</span>
                <div className="input-row">
                  <input
                    type="range"
                    min={8}
                    max={24}
                    value={customizeSettings.classBlockFontSizePx}
                    onChange={(event) => updateClassBlockFontSize(Number(event.target.value))}
                  />
                  <input
                    type="number"
                    min={8}
                    max={24}
                    value={customizeSettings.classBlockFontSizePx}
                    onChange={(event) => updateClassBlockFontSize(Number(event.target.value))}
                  />
                </div>
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

      {capturePane && <div className="export-capture" aria-hidden="true">{renderTimetable("left", capturePane)}</div>}
      <div className={`content ${splitMode ? "split-content" : ""}`}>
        <div className="main">
          {showStartPage && !splitMode ? (
            <div className="start-page">
              <div className="start-page-copy">
                <h2>Start a timetable</h2>
                <p>
                  Open an existing timetable, import a CSV, or create the first section
                  and add classes from the panel on the right.
                </p>
              </div>
              <div className="start-actions">
                <button type="button" onClick={() => setOpenMenu("file")}>
                  Open File Menu
                </button>
                <button type="button" onClick={() => openEntityEditor("section")}>
                  Create or Edit Sections
                </button>
              </div>
              <div className="start-steps">
                <div>
                  <strong>1. Bring in data</strong>
                  <span>Use File to open a saved timetable or import a schedule CSV.</span>
                </div>
                <div>
                  <strong>2. Set up lists</strong>
                  <span>Add sections, faculty, and rooms using the Edit menu.</span>
                </div>
                <div>
                  <strong>3. Add classes</strong>
                  <span>Select a timetable cell or use the Add Class form.</span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="controls">
                {splitMode && <label className="link-scroll-control"><input type="checkbox" checked={paneSettings.linked} onChange={event => setPaneSettings(prev => ({ ...prev, linked: event.target.checked }))} />Link scrolling</label>}
                {splitMode && !wideSplit && <div className="pane-tabs" aria-label="Visible schedule"><button className={activePaneId === "left" ? "active" : ""} onClick={() => activatePane("left")}>Left pane</button><button className={activePaneId === "right" ? "active" : ""} onClick={() => activatePane("right")}>Right pane</button></div>}
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
                              list={header === "Course Code" ? "course-code-list" : undefined}
                              readOnly={
                                header === "Time (24 Hrs)" ||
                                (header === "Course Description" &&
                                  Boolean(
                                    getCanonicalCourseDescriptionForSection(
                                      editEntry["Course Code"],
                                      editEntry.Section
                                    )
                                  ))
                              }
                              onChange={(event) => {
                                const value = event.target.value;
                                if (header === "Course Code") {
                                  applyCourseCodeToEditEntry(value);
                                  return;
                                }
                                if (header === "Course Description") {
                                  const canonical = getCanonicalCourseDescriptionForSection(
                                    editEntry["Course Code"],
                                    editEntry.Section
                                  );
                                  setEditEntry({
                                    ...editEntry,
                                    "Course Description": canonical || value,
                                  });
                                  return;
                                }
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
            <div className={wideSplit ? "split-timetables" : "single-timetable"} ref={splitContainerRef}
              style={wideSplit ? { gridTemplateColumns: `minmax(420px, ${paneSettings.ratio}fr) 8px minmax(420px, ${1 - paneSettings.ratio}fr)` } : undefined}>
              {wideSplit ? renderTimetable("left") : renderTimetable(activePaneId)}
              {wideSplit && <div className="pane-divider" role="separator" aria-label="Resize schedule panes" aria-orientation="vertical"
                aria-valuenow={Math.round(paneSettings.ratio * 100)} aria-valuemin={20} aria-valuemax={80} tabIndex={0}
                onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeDivider(event.clientX); }}
                onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
                onDoubleClick={() => setPaneSettings(prev => ({ ...prev, ratio: 0.5 }))}
                onKeyDown={event => {
                  if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
                    event.preventDefault();
                    const bounds = splitContainerRef.current?.getBoundingClientRect();
                    if (bounds) resizeDivider(bounds.left + (bounds.width - 8) * (event.key === "Home" ? 0.5 : paneSettings.ratio + (event.key === "ArrowLeft" ? -0.03 : 0.03)));
                  }
                }} />}
              {wideSplit && renderTimetable("right")}
            </div>
              )}
            </>
          )}
        </div>

        <ClassEditor popup={splitMode} open={editorOpen} title={formEditId ? "Edit Class" : "Add Class"}
          panelRef={panelRef} onClose={cancelEditMode} onSave={handleCreateSchedule} saving={isSaving}
        >
          {renderClassForm()}
        </ClassEditor>
      </div>
    </div>
  );
}
