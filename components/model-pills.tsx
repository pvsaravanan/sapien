"use client";

import { PROVIDERS } from "@/src/core/provider-info";
import type { Effort, ModelAlias, ProviderId } from "@/src/core/types";
import { Dropdown } from "./dropdown";

const MODELS: ModelAlias[] = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Model + effort selectors for a session's interactive agents. "" = settings default. */
export function ModelPills({
  model,
  effort,
  defaultModel,
  defaultEffort,
  onChange,
  disabled,
  provider = "claude",
}: {
  /** Model aliases are Claude-specific; other CLIs take their models from Settings. */
  provider?: ProviderId;
  model?: ModelAlias;
  effort?: Effort;
  defaultModel: string;
  defaultEffort?: string;
  onChange: (model: ModelAlias | undefined, effort: Effort | undefined) => void;
  disabled?: boolean;
}) {
  const showModel = provider === "claude";
  const showEffort = PROVIDERS[provider]?.effort ?? true;
  if (!showModel && !showEffort) return null;
  return (
    <div className="flex items-center gap-2">
      {!showModel && <span className="ui text-[0.68rem] uppercase tracking-[0.08em]" style={{ color: "var(--ink-mute)" }}>{PROVIDERS[provider].name}</span>}
      {showModel && <Dropdown<ModelAlias | "">
        size="sm"
        label="Model"
        title="Model for this session's teacher/prober/planner/coach"
        value={model ?? ""}
        disabled={disabled}
        onChange={(v) => onChange(v || undefined, effort)}
        options={[
          { value: "", label: defaultModel, hint: "default" },
          ...MODELS.filter((m) => m !== defaultModel).map((m) => ({ value: m, label: m })),
        ]}
      />}
      {showEffort && <Dropdown<Effort | "">
        size="sm"
        label="Effort"
        title="Reasoning effort"
        value={effort ?? ""}
        disabled={disabled}
        onChange={(v) => onChange(model, v || undefined)}
        options={[
          { value: "", label: defaultEffort ?? "default", hint: defaultEffort ? "default" : undefined },
          ...EFFORTS.filter((m) => m !== defaultEffort).map((m) => ({ value: m, label: m })),
        ]}
      />}
    </div>
  );
}
