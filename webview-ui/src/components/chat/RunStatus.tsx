import { useEffect, useState } from "react";
import type { ActivityEvent, TimelinePart } from "../../types";
import WorkingDots from "../common/WorkingDots";

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Always visible during a turn, including providers that send no reasoning
 * text. The timer updates only this small component, not the transcript. */
export default function RunStatus({
  startedAt,
  streamingText,
  activities,
  timeline,
  thinkingTokens = 0,
}: {
  startedAt?: number;
  streamingText: string;
  activities: ActivityEvent[];
  timeline: TimelinePart[];
  thinkingTokens?: number;
}) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const [lastUpdate, setLastUpdate] = useState(Date.now);
  useEffect(() => {
    setLastUpdate(Date.now());
  }, [streamingText, activities, thinkingTokens]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const part = timeline[timeline.length - 1];
  const last = part?.type === "text" ? undefined
    : part?.type === "activities" ? part.activities[part.activities.length - 1]
    : activities[activities.length - 1];
  const thinking = last?.type === "thinking" || last?.type === "thinking_delta";
  const quietFor = now - lastUpdate;

  return (
    <div className="flex items-center gap-2 text-[11px] px-2.5 py-1 text-vscode-descriptionFg" data-testid="run-status">
      <WorkingDots />
      <span>{thinking ? "Thinking" : "Working"}</span>
      <span role="timer" aria-live="off" className="tabular-nums">
        {duration(now - (startedAt ?? mountedAt))}
      </span>
      {thinkingTokens > 0 && (
        <span>~{thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tokens</span>
      )}
      {quietFor >= 30_000 && (
        <span className="truncate opacity-70" aria-live="off">
          · No new updates for {duration(quietFor)}
        </span>
      )}
    </div>
  );
}
