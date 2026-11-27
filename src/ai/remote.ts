import {
  fetchAndActivate,
  getRemoteConfig,
  getString,
} from "firebase/remote-config";
import { getFirebase } from "../firebase";

/** Remote Config parameter that names the cloud model for polish. */
const POLISH_MODEL_KEY = "polish_model";

let polishModel: string | null = null;

/**
 * Reads the cloud model for the polish step from Firebase Remote Config, so
 * it can be changed without a redeploy: a larger model when the project has
 * the quota for it, a smaller one when it does not. The build's default is
 * used until a value arrives, and stays if none does or the fetch fails.
 */
export async function loadRemoteModel(fallback: string): Promise<void> {
  try {
    const remote = getRemoteConfig(getFirebase().app);
    remote.defaultConfig = { [POLISH_MODEL_KEY]: fallback };
    // The SDK defaults are 12 hours and 60 seconds: too slow for a model
    // switch to reach a returning browser, and too long to hold a polish.
    remote.settings.minimumFetchIntervalMillis = 5 * 60 * 1000;
    remote.settings.fetchTimeoutMillis = 10_000;
    await fetchAndActivate(remote);
    const value = getString(remote, POLISH_MODEL_KEY).trim();
    // A model id, nothing else: this string goes into a request path.
    if (/^[a-z0-9][a-z0-9.-]{2,60}$/.test(value)) polishModel = value;
  } catch (cause) {
    console.warn("Remote Config was not read; using the default model.", cause);
  }
}

/** The polish model set remotely, or null to use the build's default. */
export function remotePolishModel(): string | null {
  return polishModel;
}
