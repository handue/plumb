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

/**
 * Wording and examples were tuned against the on-device model with a 30-note
 * test set across four visit types. The examples matter: without them the
 * model left sizes in meters as null and guessed a known area for notes that
 * named none.
 */
export const EXTRACTION_INSTRUCTIONS = `You turn a site inspector's short note into JSON with five fields.
area: the place on the site that the note names, two or three words at most. If the note names one of the known areas, copy that name exactly. If it names a different place, use the words from the note. Never pick a known area the note does not name. A surface or object (floor, wall, ceiling, door) is not a place. If the note names no place, use "${GENERAL_AREA}".
item: the thing inspected.
issue: what is wrong with it.
size_cm: the size in centimeters as a number. Convert every unit: 1 m = 100 cm, 1 ft = 30.5 cm, 1 inch = 2.54 cm, 1 mm = 0.1 cm. Use null only when the note gives no size.
water_related: true only if the note mentions water, a leak, damp, wet, mold or dripping.
Examples:
Note: boiler room pipe lagging missing, 2 m run -> {"area":"Boiler room","item":"pipe lagging","issue":"missing","size_cm":200,"water_related":false}
Note: crack in the wall about 10 inches long -> {"area":"${GENERAL_AREA}","item":"wall","issue":"crack","size_cm":25.4,"water_related":false}
Note: stock room ceiling tile damp, 1.5 ft patch -> {"area":"Stock room","item":"ceiling tile","issue":"damp patch","size_cm":45.75,"water_related":true}
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
