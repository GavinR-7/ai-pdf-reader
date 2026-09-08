"use client";

import { RATES, type Player } from "@/hooks/usePlayer";

interface PlayerControlsProps {
  player: Player;
  totalChunks: number;
  following: boolean;
  onResumeFollow: () => void;
}

/**
 * The transport bar, pinned to the bottom of the viewport.
 *
 * Bottom rather than top because this is a mobile-first reading interface and
 * the bottom of the screen is where a thumb is. It stays out of the text's way
 * by sitting on its own band rather than floating over the prose.
 */
export function PlayerControls({
  player,
  totalChunks,
  following,
  onResumeFollow,
}: PlayerControlsProps) {
  const isPlaying = player.status === "playing";
  const position = totalChunks === 0 ? 0 : ((player.index + 1) / totalChunks) * 100;

  return (
    <div className="sticky bottom-0 z-10 -mx-5 mt-10 border-t border-rule bg-paper/95 px-5 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:-mx-8 sm:px-8">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={totalChunks}
        aria-valuenow={player.index + 1}
        aria-label="Reading position"
        className="-mx-5 h-0.5 bg-rule sm:-mx-8"
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${position}%` }} />
      </div>

      {!following && (
        <div className="flex justify-center pt-3">
          <button
            onClick={onResumeFollow}
            className="rounded-full border border-rule bg-paper-raised px-3 py-1 text-xs text-ink-muted shadow-sm hover:border-accent hover:text-ink"
          >
            ↓ Back to the sentence being read
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous sentence"
            onClick={player.previous}
            disabled={player.index === 0}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M7 6h2v12H7zm10 0v12l-8-6z" />
            </svg>
          </IconButton>

          <button
            onClick={player.toggle}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-paper transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M8 5h3v14H8zm5 0h3v14h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-5 w-5 translate-x-px" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <IconButton
            label="Next sentence"
            onClick={player.next}
            disabled={player.index >= totalChunks - 1}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M15 6h2v12h-2zM7 6l8 6-8 6z" />
            </svg>
          </IconButton>
        </div>

        <p className="font-sans text-xs tabular-nums text-ink-muted">
          Sentence {Math.min(player.index + 1, totalChunks)} of {totalChunks}
          {player.currentChunk !== undefined && (
            <> · page {player.currentChunk.pageNumber}</>
          )}
        </p>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span className="sr-only sm:not-sr-only">Speed</span>
            <select
              value={player.rate}
              onChange={(event) => player.setRate(Number(event.target.value))}
              className="rounded-md border border-rule bg-paper-raised px-2 py-1 text-xs text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>

          {player.voices.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="sr-only">Voice</span>
              <select
                value={player.voiceId ?? ""}
                onChange={(event) => player.setVoiceId(event.target.value)}
                className="max-w-[10rem] truncate rounded-md border border-rule bg-paper-raised px-2 py-1 text-xs text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {player.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {player.error !== null && (
        <p role="alert" className="pb-3 text-xs text-accent">
          {player.error}
        </p>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-accent-soft hover:text-ink disabled:pointer-events-none disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}
