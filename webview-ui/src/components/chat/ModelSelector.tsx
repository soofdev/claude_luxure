import { useState, useRef, useEffect } from "react";
import { AVAILABLE_MODELS } from "../../types";

interface ModelOption {
  id: string;
  label: string;
  alias?: string;
}

interface ModelSelectorProps {
  model?: string;
  /** Provider-supplied list. Codex advertises the models its signed-in plan can
   * run, so the picker is account-specific; Claude's list is the static one. */
  options?: ModelOption[];
  onChange: (model: string) => void;
}

function resolveLabel(
  model: string | undefined,
  options: readonly ModelOption[],
  fallback: string
): string {
  if (!model) return fallback;
  const found = options.find((m) => m.id === model || m.alias === model);
  return found?.label ?? model;
}

export default function ModelSelector({ model, options, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const list: readonly ModelOption[] = options?.length
    ? options
    : AVAILABLE_MODELS;
  // Claude defaults to Sonnet when nothing is set; Codex's default is whatever
  // the account picks server-side, so say so rather than naming a wrong model.
  const fallbackLabel = options?.length ? "Default model" : "Sonnet 4";
  const currentLabel = resolveLabel(model, list, fallbackLabel);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-vscode-descriptionFg hover:text-vscode-fg hover:bg-[rgba(255,255,255,0.05)] transition-colors"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-60"
        >
          <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />
          <circle cx="12" cy="15" r="2" />
        </svg>
        <span>{currentLabel}</span>
        <svg
          width="8"
          height="5"
          viewBox="0 0 8 5"
          className={`ml-0.5 opacity-40 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          <path
            d="M1 1l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[160px] bg-[var(--vscode-dropdown-background,var(--vscode-input-background))] border border-[rgba(255,255,255,0.08)] rounded-md shadow-xl overflow-hidden z-50">
          {list.map((m) => {
            const isSelected =
              model === m.id ||
              (!!m.alias && model === m.alias) ||
              (!model && m.alias === "sonnet");
            return (
              <button
                key={m.id}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-[11px] text-left transition-colors ${
                  isSelected
                    ? "bg-[rgba(255,255,255,0.06)] text-vscode-fg"
                    : "text-vscode-descriptionFg hover:bg-[rgba(255,255,255,0.04)] hover:text-vscode-fg"
                }`}
              >
                <span className="flex-1">{m.label}</span>
                {m.alias && (
                  <span className="text-[9px] opacity-40 font-mono">
                    {m.alias}
                  </span>
                )}
                {isSelected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    className="text-vscode-fg"
                  >
                    <path
                      d="M2 6l3 3 5-5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
