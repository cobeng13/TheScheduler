import { useLayoutEffect, type ReactNode, type RefObject, type UIEvent, type MouseEvent } from "react";
import type { PaneId, PaneState, TimetableMode } from "./panes";

export function TimetablePane({ id, pane, split, active, capture, ready, scrollRef, onActivate, onMode, onAdd, onScroll, onContextMenu, onMouseUp, background, children }: {
  id: PaneId; pane: PaneState; split: boolean; active: boolean; capture: boolean; ready: boolean;
  scrollRef: RefObject<HTMLDivElement>; onActivate: () => void;
  onMode: (mode: TimetableMode) => void; onAdd: () => void;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent) => void; onMouseUp: () => void;
  background?: string; children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = pane.scrollTop;
      scrollRef.current.scrollLeft = pane.scrollLeft;
    }
  }, [scrollRef, pane.mode, pane.zoom, split, ready]);
  return <section className={`schedule-pane ${split ? "split-pane" : ""} ${active ? "active-pane" : ""}`} aria-label={`${id} schedule`} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    {split && !capture && <div className="pane-toolbar">
      <div className="pane-tabs" role="tablist" aria-label={`${id} timetable type`}>
        {(["section", "faculty", "room"] as const).map(kind => <button key={kind} role="tab" aria-selected={pane.mode === `timetable-${kind}`} onClick={() => onMode(`timetable-${kind}`)}>{kind[0].toUpperCase() + kind.slice(1)}</button>)}
      </div>
      <button onClick={onAdd}>Add Class</button>
    </div>}
    <div className="timetable" ref={scrollRef} onScroll={onScroll} onContextMenu={onContextMenu} onMouseUp={onMouseUp} style={{ backgroundColor: background }}>{children}</div>
  </section>;
}
