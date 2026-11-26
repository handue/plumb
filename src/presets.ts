import data from "./presets.json";

/**
 * A visit type. A preset only changes area suggestions, the wording hint in
 * the capture prompt, report headings and the example notes. It is data, not
 * code: add a visit type by adding an entry to presets.json.
 */
export interface Preset {
  id: string;
  label: string;
  description: string;
  reportTitle: string;
  findingsHeading: string;
  areas: string[];
  hint: string;
  examples: string[];
}

export const PRESETS: Preset[] = data;

export const CUSTOM_PRESET_ID = "custom";

export function presetById(id: string | undefined): Preset {
  return (
    PRESETS.find((preset) => preset.id === id) ??
    PRESETS.find((preset) => preset.id === CUSTOM_PRESET_ID) ??
    PRESETS[0]
  );
}
