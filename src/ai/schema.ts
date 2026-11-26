/** Units a note can give a size in, and their length in centimeters. */
export const SIZE_UNITS = { mm: 0.1, cm: 1, m: 100, in: 2.54, ft: 30.48 } as const;

export type SizeUnit = keyof typeof SIZE_UNITS;

/** What the capture step extracts from an inspector's note. */
export interface Extraction {
  /** Name of the place on the site, as the note calls it. Free text. */
  area: string;
  item: string;
  issue: string;
  /** The size as the note gave it, read by the model. */
  size_value?: number | null;
  size_unit?: SizeUnit | null;
  /** Centimeters, computed by the app from the value and unit above. */
  size_cm: number | null;
  water_related: boolean;
}

/** Area used when a note names no place. */
export const GENERAL_AREA = "General";

/**
 * One JSON Schema for both tiers: `responseConstraint` on-device and
 * `responseJsonSchema` in the cloud. The model reports the number and the
 * unit; the app does the arithmetic. Asked to convert, the on-device model
 * sometimes got it wrong (2 m became 2000 cm).
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    area: { type: "string" },
    item: { type: "string" },
    issue: { type: "string" },
    size_value: { type: ["number", "null"] },
    size_unit: {
      anyOf: [
        { type: "string", enum: Object.keys(SIZE_UNITS) },
        { type: "null" },
      ],
    },
    water_related: { type: "boolean" },
  },
  required: [
    "area",
    "item",
    "issue",
    "size_value",
    "size_unit",
    "water_related",
  ],
  additionalProperties: false,
};

/**
 * Wording and examples were tuned against the on-device model with a 30-note
 * test set across four visit types.
 */
export const EXTRACTION_INSTRUCTIONS = `You turn a site inspector's short note into JSON with six fields.
area: the place on the site that the note names, two or three words at most. If the note names one of the known areas, copy that name exactly. If it names a different place, use the words from the note. Never pick a known area the note does not name. A surface or object (floor, wall, ceiling, door) is not a place. If the note names no place, use "${GENERAL_AREA}".
item: the thing inspected.
issue: what is wrong with it.
size_value and size_unit: the size exactly as the note gives it. Copy the number and choose the unit: mm, cm, m, in or ft. Do not convert. Use null for both when the note gives no size.
water_related: true only if the note mentions water, a leak, damp, wet, mold or dripping.
Examples:
Note: boiler room pipe lagging missing, 2 m run -> {"area":"Boiler room","item":"pipe lagging","issue":"missing","size_value":2,"size_unit":"m","water_related":false}
Note: crack in the wall about 10 inches long -> {"area":"${GENERAL_AREA}","item":"wall","issue":"crack","size_value":10,"size_unit":"in","water_related":false}
Note: stock room ceiling tile damp, 1.5 ft patch -> {"area":"Stock room","item":"ceiling tile","issue":"damp patch","size_value":1.5,"size_unit":"ft","water_related":true}
Note: fire door closer broken -> {"area":"${GENERAL_AREA}","item":"fire door closer","issue":"broken","size_value":null,"size_unit":null,"water_related":false}
Output JSON only.`;

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

/** Defect categories the photo assist chooses from. */
export const PHOTO_CATEGORIES = [
  "crack or hole",
  "water damage or leak",
  "electrical",
  "blocked or cluttered",
  "broken or missing part",
  "dirt, mold or pests",
  "other",
] as const;

/** What the optional photo assist reads from one photo. */
export interface PhotoSuggestion {
  note: string;
  category: (typeof PHOTO_CATEGORIES)[number];
}

export const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string" },
    category: { type: "string", enum: [...PHOTO_CATEGORIES] },
  },
  required: ["note", "category"],
  additionalProperties: false,
};

export const PHOTO_INSTRUCTIONS = `You help a site inspector draft a note from one photo. Describe only what is visible. note is one short phrase an inspector would type, naming the thing and what is wrong with it, with no location. category is the kind of defect. If nothing looks wrong, say so in note and use "other". Output JSON only.`;

export const PHOTO_PROMPT = "Draft the inspector's note for this photo.";

/** Parses and validates model output. Throws if it does not match. */
export function parsePhotoSuggestion(text: string): PhotoSuggestion {
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    typeof data.note !== "string" ||
    data.note.trim() === "" ||
    !PHOTO_CATEGORIES.includes(data.category as PhotoSuggestion["category"])
  ) {
    throw new Error("Model output does not match the photo schema.");
  }
  return {
    note: data.note.trim(),
    category: data.category as PhotoSuggestion["category"],
  };
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

export const POLISH_INSTRUCTIONS = `You are a site inspection report editor. You receive the visit type, one finding as JSON and the inspector's original note. Write one or two clear sentences for the report. Assign a severity. High: immediate danger to people or to the structure, or active water damage. Moderate: a defect or hazard that needs repair soon but is not an immediate danger, such as a trip hazard or a worn part. Low: cosmetic issues and routine maintenance. Set water_flag for leaks, damp or mold, and safety_flag for electrical, fire, structural or fall hazards. Use the given Area as the location and do not name a different one. Do not invent details that are not in the note.`;

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
    !(data.size_value === null || typeof data.size_value === "number") ||
    !(data.size_unit === null || (data.size_unit as string) in SIZE_UNITS) ||
    typeof data.water_related !== "boolean"
  ) {
    throw new Error("Model output does not match the extraction schema.");
  }
  const value = data.size_value;
  const unit = data.size_unit as SizeUnit | null;
  // A size needs both parts, and a size of zero is no size.
  const sized = value !== null && unit !== null && value > 0;
  return {
    area: data.area,
    item: data.item,
    issue: data.issue,
    size_value: sized ? value : null,
    size_unit: sized ? unit : null,
    size_cm: sized ? Math.round(value * SIZE_UNITS[unit] * 10) / 10 : null,
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
