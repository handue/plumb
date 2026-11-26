import { InferenceSource, type Part } from "firebase/ai";
import {
  getModel,
  onDeviceAvailability,
  photoAvailability,
  type Route,
} from "./models";

/** Routes that must be answered on the device or not at all. */
const DEVICE_ONLY: Route[] = ["captureOffline", "photo"];

/** One measured model call. Every value here is observed, never estimated. */
export interface RunRecord {
  route: Route;
  /** Tier that answered, as reported by the SDK. Null if the call failed. */
  source: InferenceSource | null;
  /** Wall-clock milliseconds around the call. */
  ms: number;
  /** ISO timestamp taken when the call returned. */
  at: string;
  /** Browser network state when the call started. */
  online: boolean;
  text: string | null;
  error: string | null;
}

/**
 * Upper bound for routes that can reach the cloud. The SDK's own timeout only
 * covers the HTTP request, not the App Check token that precedes it, so a
 * stalled token would otherwise leave the call pending forever.
 */
const CLOUD_TIMEOUT_MS = 90_000;
const DEVICE_TIMEOUT_MS = 120_000;

/**
 * Returns why a route cannot run right now, or null if it can. A blocked
 * route makes no model call, so it must not appear in the measured log.
 */
export async function blocker(route: Route): Promise<string | null> {
  if (!DEVICE_ONLY.includes(route)) return null;

  const state =
    route === "photo" ? await photoAvailability() : await onDeviceAvailability();
  switch (state) {
    case "available":
      return null;
    case "downloadable":
    case "downloading":
      return "The on-device model is not downloaded yet. Prepare it first, while online.";
    case "missing":
      return "This browser has no on-device model. Use Chrome desktop 148 or later.";
    default:
      return `The on-device model is not available on this device (${state}).`;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`No answer after ${Math.round(ms / 1000)} seconds.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * With `onText`, the call is streamed and `onText` receives the answer so far
 * each time more of it arrives. The record is the same either way.
 */
export async function run(
  route: Route,
  prompt: string | Array<string | Part>,
  onText?: (soFar: string) => void,
): Promise<RunRecord> {
  const online = navigator.onLine;
  const started = performance.now();
  const finish = (
    fields: Pick<RunRecord, "source" | "text" | "error">,
  ): RunRecord => ({
    route,
    ms: Math.round(performance.now() - started),
    at: new Date().toISOString(),
    online,
    ...fields,
  });

  try {
    // Aborting stops a cloud request that is still waiting to be sent. The
    // SDK does not pass the signal to the on-device model.
    const controller = new AbortController();
    const model = getModel(route);
    // Set once the call is over, so a stream that outlives a timeout (the SDK
    // cannot abort an on-device one) stops reporting text for a dead call.
    let settled = false;
    const call = onText
      ? (async () => {
          const streamed = await model.generateContentStream(prompt, {
            signal: controller.signal,
          });
          // The stream's own error is the one to surface; this copy of it
          // must not become an unhandled rejection.
          streamed.response.catch(() => undefined);
          let soFar = "";
          for await (const chunk of streamed.stream) {
            if (settled) break;
            soFar += chunk.text();
            onText(soFar);
          }
          return { response: await streamed.response };
        })()
      : model.generateContent(prompt, { signal: controller.signal });
    // A device-only call gets a longer limit, above the measured cold load,
    // so one stuck call cannot hold every later note behind it.
    const limit = DEVICE_ONLY.includes(route) ? DEVICE_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
    const result = await withTimeout(call, limit, () => controller.abort()).finally(
      () => {
        settled = true;
      },
    );
    const source = result.response.inferenceSource ?? null;

    // A device-only call answered by anything else is a routing fault, not a
    // result. Surface it instead of showing the output.
    if (DEVICE_ONLY.includes(route) && source !== InferenceSource.ON_DEVICE) {
      return finish({
        source,
        text: null,
        error: "A device-only call was not answered on the device.",
      });
    }

    return finish({ source, text: result.response.text(), error: null });
  } catch (cause) {
    return finish({
      source: null,
      text: null,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
