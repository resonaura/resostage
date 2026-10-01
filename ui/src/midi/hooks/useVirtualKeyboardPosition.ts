// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

interface KeyboardPosition {
  x: number;
  y: number;
}

interface DragStart {
  startX: number;
  startY: number;
  initX: number;
  initY: number;
}

/** Owns persisted floating-window placement and pointer-driven repositioning. */
export function useVirtualKeyboardPosition() {
  const [position, setPosition] = useState<KeyboardPosition | null>(() => {
    try {
      const saved = localStorage.getItem("resostage:virtual-keyboard-pos");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          return parsed;
        }
      }
    } catch {}
    return null;
  });

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<DragStart>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });
  const currentPosRef = useRef<KeyboardPosition | null>(position);
  const rafIdRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize centered bottom position on mount if none saved.
  useEffect(() => {
    if (position === null && typeof window !== "undefined") {
      const defaultWidth = Math.min(680, window.innerWidth * 0.96);
      const defaultHeight = 180;
      const x = Math.max(
        10,
        Math.round((window.innerWidth - defaultWidth) / 2),
      );
      const y = Math.max(
        10,
        Math.round(window.innerHeight - defaultHeight - 36),
      );
      setPosition({ x, y });
      currentPosRef.current = { x, y };
    }
  }, [position]);

  const handlePointerDownHeader = (event: PointerEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest(
        "button, input, [role='slider'], .rs-slider",
      )
    )
      return;
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const startX = Math.round(rect.left);
    const startY = Math.round(rect.top);

    isDraggingRef.current = true;
    setIsDragging(true);
    setPosition({ x: startX, y: startY });
    currentPosRef.current = { x: startX, y: startY };

    dragStartRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      initX: startX,
      initY: startY,
    };

    element.style.left = `${startX}px`;
    element.style.top = `${startY}px`;
    element.style.bottom = "auto";
    element.style.transform = "none";

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  };

  const handlePointerMoveHeader = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const element = containerRef.current;
    const width = element?.offsetWidth || 680;
    const height = element?.offsetHeight || 180;
    const minX = 8;
    const maxX = Math.max(8, window.innerWidth - width - 8);
    const minY = 8;
    const maxY = Math.max(8, window.innerHeight - height - 8);

    const dx = event.clientX - dragStartRef.current.startX;
    const dy = event.clientY - dragStartRef.current.startY;
    const newX = Math.max(
      minX,
      Math.min(maxX, dragStartRef.current.initX + dx),
    );
    const newY = Math.max(
      minY,
      Math.min(maxY, dragStartRef.current.initY + dy),
    );
    currentPosRef.current = { x: Math.round(newX), y: Math.round(newY) };

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (containerRef.current && currentPosRef.current) {
          containerRef.current.style.left = `${currentPosRef.current.x}px`;
          containerRef.current.style.top = `${currentPosRef.current.y}px`;
        }
      });
    }
  };

  const handlePointerUpHeader = (event: PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (currentPosRef.current) {
        setPosition(currentPosRef.current);
        localStorage.setItem(
          "resostage:virtual-keyboard-pos",
          JSON.stringify(currentPosRef.current),
        );
      }
    }
  };

  const handleResetPosition = () => {
    localStorage.removeItem("resostage:virtual-keyboard-pos");
    const defaultWidth = Math.min(680, window.innerWidth * 0.96);
    const defaultHeight = 180;
    const x = Math.max(10, Math.round((window.innerWidth - defaultWidth) / 2));
    const y = Math.max(10, Math.round(window.innerHeight - defaultHeight - 36));
    setPosition({ x, y });
    currentPosRef.current = { x, y };
    if (containerRef.current) {
      containerRef.current.style.left = `${x}px`;
      containerRef.current.style.top = `${y}px`;
      containerRef.current.style.transform = "none";
      containerRef.current.style.bottom = "auto";
    }
  };

  useEffect(
    () => () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    },
    [],
  );

  return {
    position,
    isDragging,
    containerRef,
    handlePointerDownHeader,
    handlePointerMoveHeader,
    handlePointerUpHeader,
    handleResetPosition,
  };
}
