import {
  getGenerativeModel,
  InferenceMode,
  type GenerativeModel,
  type OnDeviceParams,
} from "firebase/ai";
import { getFirebase } from "../firebase";
import { remotePolishModel } from "./remote";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA,
  PHOTO_INSTRUCTIONS,
  PHOTO_SCHEMA,
  POLISH_INSTRUCTIONS,
  POLISH_SCHEMA,
} from "./schema";

/** Cloud model for the capture fallback: small and fast, same job as Nano. */
export const CAPTURE_CLOUD_MODEL = "gemini-3.5-flash-lite";
/**
 * Cloud model for polish and severity. The default is the model whose free
 * quota is large enough for a public demo; larger models had a daily free
 * quota of 20 requests when this was tested. Set VITE_POLISH_MODEL to use a
 * larger one on a project with billing.
 */
export const POLISH_CLOUD_MODEL =
  import.meta.env.VITE_POLISH_MODEL || "gemini-3.5-flash-lite";

/**
 * The on-device model takes its system prompt and schema through Chrome's
 * Prompt API options. The cloud `systemInstruction` and `responseJsonSchema`
 * are not forwarded to it, so both tiers are configured side by side.
 */
export const CAPTURE_ON_DEVICE: OnDeviceParams = {
  createOptions: {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    initialPrompts: [
      {
        role: "system",
        content: [{ type: "text", value: EXTRACTION_INSTRUCTIONS }],
      },
    ],
  },
  // The schema still constrains the output. Leaving it out of the model's
  // input shortens the prompt, which cut the measured latency by about a
  // third; the instructions already describe every field.
  promptOptions: {
    responseConstraint: EXTRACTION_SCHEMA,
    omitResponseConstraintInput: true,
  } as OnDeviceParams["promptOptions"],
};

const captureCloud = {
  model: CAPTURE_CLOUD_MODEL,
  systemInstruction: EXTRACTION_INSTRUCTIONS,
  generationConfig: {
    responseMimeType: "application/json",
    responseJsonSchema: EXTRACTION_SCHEMA,
  },
};

/**
 * Image input needs its own session options: a session created for text only
 * rejects images. Used by the optional photo assist, on the device only.
 */
export const PHOTO_ON_DEVICE: OnDeviceParams = {
  createOptions: {
    expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    initialPrompts: [
      {
        role: "system",
        content: [{ type: "text", value: PHOTO_INSTRUCTIONS }],
      },
    ],
  },
  promptOptions: { responseConstraint: PHOTO_SCHEMA },
};

export type Route =
  | "capture"
  | "captureCloud"
  | "captureOffline"
  | "polish"
  | "photo";

/** Firebase AI Logic inference mode behind each route, as shown in the log. */
export const ROUTE_MODES: Record<Route, string> = {
  capture: "PREFER_ON_DEVICE",
  captureCloud: "ONLY_IN_CLOUD",
  captureOffline: "ONLY_ON_DEVICE",
  polish: "ONLY_IN_CLOUD",
  photo: "ONLY_ON_DEVICE",
};

/** The slice of Chrome's Prompt API used to check model state. */
interface PromptApi {
  availability(options?: unknown): Promise<string>;
}

function promptApi(): PromptApi | undefined {
  return (globalThis as { LanguageModel?: PromptApi }).LanguageModel;
}

/**
 * State of the on-device model for the capture configuration: "available",
 * "downloadable", "downloading", "unavailable", or "missing" when the browser
 * has no Prompt API at all. Reads state only; runs no inference.
 */
export async function onDeviceAvailability(): Promise<string> {
  const api = promptApi();
  if (!api) return "missing";
  try {
    return await api.availability(CAPTURE_ON_DEVICE.createOptions);
  } catch {
    return "unavailable";
  }
}

/**
 * State of the on-device model for image input, which can differ from the
 * text-only state. Reads state only; runs no inference.
 */
export async function photoAvailability(): Promise<string> {
  const api = promptApi();
  if (!api) return "missing";
  try {
    return await api.availability(PHOTO_ON_DEVICE.createOptions);
  } catch {
    return "unavailable";
  }
}

const cache = new Map<Route, GenerativeModel>();

/**
 * One model instance per routing decision:
 *
 * - capture: PREFER_ON_DEVICE. Gemini Nano when the browser has it, cloud
 *   otherwise, so capture still works on machines without the model.
 * - captureCloud: ONLY_IN_CLOUD. The same job on the cloud model, used while
 *   online after the on-device model was reported ready but failed. The SDK
 *   does not fall back by itself in that case.
 * - captureOffline: ONLY_ON_DEVICE. Chosen explicitly by the caller when the
 *   note must stay on the device. Never reaches the cloud.
 * - polish: ONLY_IN_CLOUD. Severity is a judgment call that stays with the
 *   cloud model, so it waits for a connection instead of falling back.
 */
export function getModel(route: Route): GenerativeModel {
  const cached = cache.get(route);
  if (cached) return cached;

  const { ai } = getFirebase();
  let model: GenerativeModel;

  switch (route) {
    case "capture":
      model = getGenerativeModel(ai, {
        mode: InferenceMode.PREFER_ON_DEVICE,
        onDeviceParams: CAPTURE_ON_DEVICE,
        inCloudParams: captureCloud,
      });
      break;
    case "captureCloud":
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: captureCloud,
      });
      break;
    case "captureOffline":
      // Without the Prompt API the SDK builds no on-device adapter and sends
      // every request to the cloud, whatever the mode. Refuse instead.
      if (!promptApi()) {
        throw new Error(
          "This browser has no on-device model, so a device-only call cannot run.",
        );
      }
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: CAPTURE_ON_DEVICE,
      });
      break;
    case "photo":
      if (!promptApi()) {
        throw new Error(
          "This browser has no on-device model, so a photo cannot be read on the device.",
        );
      }
      // Photos never go to the cloud: there is no cloud configuration here.
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: PHOTO_ON_DEVICE,
      });
      break;
    case "polish":
      model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          // Remote Config can name another model; the build's default otherwise.
          model: remotePolishModel() ?? POLISH_CLOUD_MODEL,
          systemInstruction: POLISH_INSTRUCTIONS,
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: POLISH_SCHEMA,
          },
        },
      });
      break;
  }

  cache.set(route, model);
  return model;
}

/**
 * Starts the Gemini Nano download if needed and resolves when the model is
 * ready. Chrome requires this to run on or after a user gesture.
 */
export async function prepareOnDeviceModel(
  onProgress?: (fraction: number) => void,
): Promise<void> {
  await getModel("captureOffline").initializeDeviceModel(onProgress);
}
