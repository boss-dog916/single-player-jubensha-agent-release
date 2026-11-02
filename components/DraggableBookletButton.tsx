"use client";
import { useEffect, useRef, useState } from "react";
import { clampFloatingPosition, isDragMovement, type FloatingPosition } from "./playerInteraction";

const storageKey = "booklet-button-position:v1";
export function DraggableBookletButton({ onClick }: { onClick: () => void }) {
  const button = useRef<HTMLButtonElement>(null), point = useRef<FloatingPosition | null>(null);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: FloatingPosition; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const move = (next: FloatingPosition) => {
    const rect = button.current?.getBoundingClientRect();
    const clamped = clampFloatingPosition(next, { width: window.innerWidth, height: window.innerHeight },
      { width: rect?.width ?? 112, height: rect?.height ?? 48 });
    point.current = clamped; setPosition(clamped); return clamped;
  };
  const remember = () => { try { window.localStorage.setItem(storageKey, JSON.stringify(point.current)); } catch { /* Drag remains usable without storage. */ } };
  useEffect(() => {
    const rect = button.current?.getBoundingClientRect();
    let saved: FloatingPosition | null = null;
    try { saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null"); } catch { /* Use default. */ }
    move(saved ?? { x: window.innerWidth - (rect?.width ?? 112) - 20, y: window.innerHeight - 144 });
    const resize = () => { if (point.current) { move(point.current); remember(); } };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return <button ref={button} type="button" title="点击打开，拖动调整位置" aria-label="我的剧本，可拖动"
    className="fixed bottom-24 right-5 z-30 h-12 touch-none select-none rounded-full bg-ember px-5 text-sm font-semibold text-white shadow-panel hover:bg-ember/90"
    style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      const rect = event.currentTarget.getBoundingClientRect(); suppressClick.current = false;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { x: rect.left, y: rect.top }, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const current = drag.current; if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      current.moved ||= isDragMovement(dx, dy);
      if (current.moved) { event.preventDefault(); move({ x: current.start.x + dx, y: current.start.y + dy }); }
    }}
    onPointerUp={event => {
      const current = drag.current; if (!current || current.id !== event.pointerId) return;
      suppressClick.current = current.moved; if (current.moved) remember(); drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; suppressClick.current = false; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onClick={event => { const skip = suppressClick.current && event.detail !== 0; suppressClick.current = false; if (!skip) onClick(); }}>
    我的剧本
  </button>;
}
