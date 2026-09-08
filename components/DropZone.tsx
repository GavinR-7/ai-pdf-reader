"use client";

import { useCallback, useRef, useState } from "react";

interface DropZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

/**
 * File picker plus drag-and-drop, accepting a single PDF.
 *
 * The visible control is a real `<label>` wired to a visually-hidden
 * `<input type="file">` rather than a `<div onClick>` that calls `.click()`.
 * That keeps keyboard focus, the space/enter activation, and the screen-reader
 * announcement for free, which a div would have to reimplement and usually
 * gets wrong.
 */
export function DropZone({ onFile, disabled = false }: DropZoneProps) {
  const [isOver, setIsOver] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (file: File | undefined) => {
      if (file === undefined) return;
      const isPdf =
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        setRejected(`"${file.name}" is not a PDF.`);
        return;
      }
      setRejected(null);
      onFile(file);
    },
    [onFile],
  );

  return (
    <div className="w-full">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsOver(true);
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsOver(false);
          if (disabled) return;
          accept(event.dataTransfer.files[0]);
        }}
        className={[
          "flex cursor-pointer flex-col items-center justify-center gap-3",
          "rounded-lg border border-dashed px-6 py-14 text-center transition-colors",
          "focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
          isOver
            ? "border-accent bg-accent-soft"
            : "border-rule bg-paper-raised hover:border-ink-faint",
          disabled ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            accept(event.target.files?.[0]);
            // Clear the value so re-picking the same file fires `change` again.
            event.target.value = "";
          }}
        />
        <span className="text-base font-medium text-ink">
          Drop a PDF here, or choose a file
        </span>
        <span className="text-sm text-ink-muted">
          The file is read in your browser. It is never uploaded.
        </span>
      </label>
      {rejected !== null && (
        <p role="alert" className="mt-3 text-sm text-accent">
          {rejected}
        </p>
      )}
    </div>
  );
}
