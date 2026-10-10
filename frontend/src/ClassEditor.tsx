import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export function ClassEditor({ popup, open, title, onClose, onSave, saving, panelRef, children }: {
  popup: boolean; open: boolean; title: string; onClose: () => void;
  onSave: () => void; saving: boolean; panelRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!popup || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current!;
    (dialog.querySelector("input") || dialog.querySelector("button"))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", onKey);
    return () => { dialog.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [popup, open]);
  if (popup && !open) return null;
  if (!popup) return <aside className={`panel ${title === "Edit Class" ? "editing" : ""}`} ref={panelRef}>{children}</aside>;
  return <div className="class-editor-backdrop">
    <div className="class-editor-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="class-editor-title">
      <header><h2 id="class-editor-title">{title}</h2><button aria-label="Close class editor" disabled={saving} onClick={onClose}>×</button></header>
      <div className="panel class-editor-body" ref={panelRef}>{children}</div>
      <footer><button disabled={saving} onClick={onClose}>Cancel</button><button disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</button></footer>
    </div>
  </div>;
}
