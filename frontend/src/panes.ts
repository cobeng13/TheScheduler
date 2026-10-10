export type PaneId = "left" | "right";
export type TimetableMode = "timetable-section" | "timetable-faculty" | "timetable-room";
export type PaneState = {
  mode: TimetableMode;
  section: string;
  faculty: string;
  room: string;
  zoom: number;
  scrollTop: number;
  scrollLeft: number;
};
export type PaneSettings = {
  split: boolean;
  linked: boolean;
  ratio: number;
  active: PaneId;
  left: PaneState;
  right: PaneState;
};
export const paneField = (mode: TimetableMode) => mode.slice(10) as "section" | "faculty" | "room";
export const assignmentForPane = (pane: PaneState) => ({ kind: paneField(pane.mode), name: pane[paneField(pane.mode)] });
export const linkedScrollTop = (top: number, sourceZoom: number, destinationZoom: number) => top * destinationZoom / sourceZoom;
export function defaultPaneSettings(): PaneSettings {
  const pane: PaneState = { mode: "timetable-section", section: "", faculty: "", room: "", zoom: 100, scrollTop: 0, scrollLeft: 0 };
  return { split: false, linked: true, ratio: 0.5, active: "left", left: { ...pane }, right: { ...pane, mode: "timetable-faculty" } };
}
export function loadPaneSettings(): PaneSettings {
  const defaults = defaultPaneSettings();
  try {
    const saved = JSON.parse(localStorage.getItem("scheduler.panes") || "null");
    if (!saved || typeof saved !== "object") return defaults;
    for (const id of ["left", "right"] as const) {
      const pane = saved[id];
      if (!pane || !["timetable-section", "timetable-faculty", "timetable-room"].includes(pane.mode)) continue;
      defaults[id] = {
        ...defaults[id], mode: pane.mode,
        section: typeof pane.section === "string" ? pane.section : "",
        faculty: typeof pane.faculty === "string" ? pane.faculty : "",
        room: typeof pane.room === "string" ? pane.room : "",
        zoom: typeof pane.zoom === "number" ? Math.min(130, Math.max(75, pane.zoom)) : 100,
        scrollTop: Math.max(0, Number(pane.scrollTop) || 0), scrollLeft: Math.max(0, Number(pane.scrollLeft) || 0),
      };
    }
    defaults.split = saved.split === true;
    defaults.linked = saved.linked !== false;
    defaults.active = saved.active === "right" ? "right" : "left";
    defaults.ratio = typeof saved.ratio === "number" ? Math.min(0.8, Math.max(0.2, saved.ratio)) : 0.5;
  } catch { /* A malformed preference must not prevent opening the schedule. */ }
  return defaults;
}
