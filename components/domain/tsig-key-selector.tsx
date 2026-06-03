"use client";

/**
 * components/domain/tsig-key-selector.tsx
 *
 * Shared selector for creation-style flows that can pre-apply a transfer TSIG
 * key. The caller owns eligibility and defaulting; this component only renders
 * the same operator-facing choice consistently across zone create/import.
 */

export interface SelectableTsigKey {
  name: string;
  zoneCount: number;
}

export function TsigKeySelector({
  keys,
  selected,
  onSelect,
}: {
  keys: SelectableTsigKey[];
  selected: string;
  onSelect: (next: string) => void;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onSelect("")}
        aria-pressed={selected === ""}
        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${
          selected === ""
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10"
            : "border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
        }`}
      >
        <span
          aria-hidden
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            selected === "" ? "bg-[color:var(--color-accent)]" : "bg-[color:var(--color-border)]"
          }`}
        />
        <span className="min-w-0">
          <span className="block font-medium">No TSIG key</span>
          <span className="block text-xs text-[color:var(--color-fg-muted)]">
            Create the zone without transfer authentication.
          </span>
        </span>
      </button>
      {keys.map((key, index) => {
        const active = selected === key.name;
        return (
          <button
            key={key.name}
            type="button"
            onClick={() => onSelect(key.name)}
            aria-pressed={active}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${
              active
                ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10"
                : "border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
            }`}
          >
            <span
              aria-hidden
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                active ? "bg-[color:var(--color-accent)]" : "bg-[color:var(--color-border)]"
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs break-all">{key.name}</span>
              <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
                {key.zoneCount} existing domain{key.zoneCount === 1 ? "" : "s"} use this key
                {index === 0 ? " - default" : ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
