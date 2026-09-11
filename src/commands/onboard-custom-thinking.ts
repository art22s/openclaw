// Parses custom-provider thinking capabilities captured by onboarding.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  MODEL_DATA_THINKING_LEVELS,
  type ModelDataThinkingLevel,
  type ModelDataThinkingLevelMap,
} from "../../packages/llm-core/src/model-data.js";

const CUSTOM_THINKING_LEVELS = new Set<string>(MODEL_DATA_THINKING_LEVELS);

function isCustomThinkingLevel(value: string): value is ModelDataThinkingLevel {
  return CUSTOM_THINKING_LEVELS.has(value);
}

export function assertCustomThinkingLevelsSupported(params: {
  compatibility: string;
  thinkingLevelMap?: ModelDataThinkingLevelMap;
}): void {
  if (params.thinkingLevelMap && params.compatibility === "anthropic") {
    throw new Error(
      "Custom thinking levels are currently supported only for OpenAI-compatible endpoints.",
    );
  }
}

/** Parses canonical OpenClaw thinking levels with optional provider-native mappings. */
export function parseCustomThinkingLevels(raw?: string): ModelDataThinkingLevelMap | undefined {
  const normalized = normalizeOptionalString(raw);
  if (!normalized) {
    return undefined;
  }

  const configured = new Map<ModelDataThinkingLevel, string>();
  for (const rawEntry of normalized.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf("=");
    const rawLevel = (separator === -1 ? entry : entry.slice(0, separator)).trim().toLowerCase();
    const providerValue = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    if (!isCustomThinkingLevel(rawLevel) || !providerValue || configured.has(rawLevel)) {
      throw new Error(
        `Invalid custom thinking levels. Use comma-separated ${MODEL_DATA_THINKING_LEVELS.join(
          ", ",
        )} entries, optionally mapped as level=provider-value.`,
      );
    }
    configured.set(rawLevel, providerValue);
  }

  return Object.fromEntries(
    MODEL_DATA_THINKING_LEVELS.map((level) => [level, configured.get(level) ?? null]),
  );
}
