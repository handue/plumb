import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  CustomProvider,
  ReCaptchaEnterpriseProvider,
  initializeAppCheck,
} from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";

declare global {
  // Read by the App Check SDK to switch on the debug provider.
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}

export type AppCheckMode = "debug" | "recaptcha-enterprise" | "none";

export interface FirebaseContext {
  app: FirebaseApp;
  ai: AI;
  appCheckMode: AppCheckMode;
}

// Each variable is read by its full static name so the bundler inlines only
// the values that are used. Never alias or index `import.meta.env`: that
// would embed every VITE_ variable, including the debug token, in the build.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const CONFIG_NAMES: Record<keyof typeof firebaseConfig, string> = {
  apiKey: "VITE_FIREBASE_API_KEY",
  authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
  projectId: "VITE_FIREBASE_PROJECT_ID",
  appId: "VITE_FIREBASE_APP_ID",
};

/** Names of required config values that are not set. Empty when ready. */
export function missingConfig(): string[] {
  return (Object.keys(firebaseConfig) as (keyof typeof firebaseConfig)[])
    .filter((key) => !firebaseConfig[key])
    .map((key) => CONFIG_NAMES[key]);
}

function isLocalHost(): boolean {
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

let appCheckScriptFailed = false;
let appCheckFailedOffline = false;
let onAppCheckBlocked: (() => void) | null = null;

/**
 * True once the reCAPTCHA script that App Check needs has failed to load. The
 * SDK does not watch for that, so its token request, and every cloud call
 * behind it, would wait forever.
 */
export function appCheckBlocked(): boolean {
  return appCheckScriptFailed;
}

/**
 * True if that script failed while the browser had no connection: nothing
 * blocked it, and a reload with a connection loads it.
 */
export function appCheckMissedOffline(): boolean {
  return appCheckFailedOffline;
}

/** Calls `listener` when the App Check script fails to load, or now if it has. */
export function whenAppCheckBlocked(listener: () => void): void {
  onAppCheckBlocked = listener;
  if (appCheckScriptFailed) listener();
}

/**
 * App Check protects the cloud path only. Firebase AI Logic attaches a token
 * to cloud requests; on-device requests never leave the browser and need none.
 */
function setUpAppCheck(app: FirebaseApp): AppCheckMode {
  // `import.meta.env.DEV` is a build-time constant, so a production build
  // drops the debug token from the bundle even if it is present in .env.
  const debugToken = import.meta.env.DEV
    ? import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
    : undefined;
  const siteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;

  // The debug provider is for local development only: dev server, localhost.
  if (debugToken && isLocalHost()) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken === "true" ? true : debugToken;
    initializeAppCheck(app, {
      // Never called while the debug token is active.
      provider: new CustomProvider({
        getToken: () =>
          Promise.reject(new Error("App Check debug provider is active.")),
      }),
      isTokenAutoRefreshEnabled: true,
    });
    return "debug";
  }

  if (siteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    // The SDK has just added the script, with no error handler of its own.
    // A blocked or failed load fires `error`; a slow one does not.
    document
      .querySelector('script[src*="recaptcha/enterprise.js"]')
      ?.addEventListener("error", () => {
        appCheckScriptFailed = true;
        appCheckFailedOffline = !navigator.onLine;
        onAppCheckBlocked?.();
      });
    return "recaptcha-enterprise";
  }

  return "none";
}

let context: FirebaseContext | null = null;

/**
 * Initializes Firebase once. App Check must be set up before any other
 * Firebase service is used, and getAI() must only be called once.
 */
export function getFirebase(): FirebaseContext {
  if (context) return context;

  const missing = missingConfig();
  if (missing.length > 0) {
    throw new Error(`Missing Firebase config: ${missing.join(", ")}`);
  }

  const app = initializeApp(firebaseConfig);
  const appCheckMode = setUpAppCheck(app);
  const ai = getAI(app, { backend: new GoogleAIBackend() });

  context = { app, ai, appCheckMode };
  return context;
}
