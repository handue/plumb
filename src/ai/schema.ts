/** What the capture step extracts from an inspector's note. */
export interface Extraction {
  /** Name of the place on the site, as the note calls it. Free text. */
  area: string;
  item: string;
  issue: string;
  size_cm: number | null;
  water_related: boolean;
}

/** Area used when a note names no place. */
export const GENERAL_AREA = "General";

/**
 * One JSON Schema for both tiers: `responseConstraint` on-device and
 * `responseJsonSchema` in the cloud.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    area: { type: "string" },
    item: { type: "string" },
    issue: { type: "string" },
    size_cm: { type: ["number", "null"] },
    water_related: { type: "boolean" },
  },
  required: ["area", "item", "issue", "size_cm", "water_related"],
  additionalProperties: false,
};

export const EXTRACTION_INSTRUCTIONS = `You extract structured fields from a site inspector's short note. area is the place on the site the note is about, two or three words at most. If the place matches one of the known areas, copy that name exactly; otherwise use the words from the note. If the note names no place, use "${GENERAL_AREA}". item is the thing inspected. issue is what is wrong with it. Convert feet and inches to centimeters (1 ft = 30.5 cm, 1 inch = 2.54 cm). size_cm is null when no size is stated. water_related is true only if the note mentions water, leaks, damp, wet, mold or dripping. Output JSON only.`;

/** The per-call prompt: visit context first, then the note. */
export function extractionPrompt(
  note: string,
  context: { visitType: string; hint: string; knownAreas: string[] },
): string {
  return [
    `Visit type: ${context.visitType}`,
    context.hint,
    `Known areas: ${context.knownAreas.length > 0 ? context.knownAreas.join(", ") : "none yet"}`,
    `Note: ${note}`,
  ].join("\n");
}

export const SEVERITIES = ["Low", "Moderate", "High"] as const;

export type Severity = (typeof SEVERITIES)[number];

/** What the cloud polish step adds to a captured finding. */
export interface Polish {
  sentence: string;
  severity: Severity;
  water_flag: boolean;
  safety_flag: boolean;
}

export const POLISH_SCHEMA = {
  type: "object",
  properties: {
    sentence: { type: "string" },
    severity: { type: "string", enum: [...SEVERITIES] },
    water_flag: { type: "boolean" },
    safety_flag: { type: "boolean" },
  },
  required: ["sentence", "severity", "water_flag", "safety_flag"],
  additionalProperties: false,
};

export const POLISH_INSTRUCTIONS = `You are a site inspection report editor. You receive the visit type, one finding as JSON and the inspector's original note. Write one or two clear sentences for the report. Assign a severity: High for safety hazards or active water damage, Moderate for defects that need repair soon, Low for cosmetic issues. Set water_flag for leaks, damp or mold, and safety_flag for electrical, fire, structural or fall hazards. Use the given Area as the location and do not name a different one. Do not invent details that are not in the note.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates model output. Throws if it does not match. */
export function parseExtraction(text: string): Extraction {
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    typeof data.area !== "string" ||
    typeof data.item !== "string" ||
    typeof data.issue !== "string" ||
    !(data.size_cm === null || typeof data.size_cm === "number") ||
    typeof data.water_related !== "boolean"
  ) {
    throw new Error("Model output does not match the extraction schema.");
  }
  return {
    area: data.area,
    item: data.item,
    issue: data.issue,
    size_cm: data.size_cm,
    water_related: data.water_related,
  };
}

/** Parses and validates model output. Throws if it does not match. */
export function parsePolish(text: string): Polish {
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    typeof data.sentence !== "string" ||
    !SEVERITIES.includes(data.severity as Severity) ||
    typeof data.water_flag !== "boolean" ||
    typeof data.safety_flag !== "boolean"
  ) {
    throw new Error("Model output does not match the polish schema.");
  }
  return {
    sentence: data.sentence,
    severity: data.severity as Severity,
    water_flag: data.water_flag,
    safety_flag: data.safety_flag,
  };
}
