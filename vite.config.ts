import { createHash } from "node:crypto";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Emits a service worker that precaches the built app shell, so the app
 * opens with no network after the first visit. Model calls are not cached:
 * on-device calls never reach the network, and cloud calls must be live.
 */
/**
 * A hosted build without the reCAPTCHA Enterprise site key would ship with no
 * App Check at all and every cloud call would be refused. Fail the build
 * instead of finding that out in front of a user.
 */
function requireAppCheckKey(): Plugin {
  return {
    name: "plumb-require-app-check-key",
    apply: "build",
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), "VITE_");
      if (mode === "production" && !env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY) {
        throw new Error(
          "A production build needs VITE_RECAPTCHA_ENTERPRISE_SITE_KEY for App Check.",
        );
      }
    },
  };
}

function appShellServiceWorker(): Plugin {
  return {
    name: "plumb-app-shell-sw",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => `/${name}`);
      const assets = [...new Set(["/", "/favicon.svg", ...files])].sort();
      const version = createHash("sha256")
        .update(
          Object.values(bundle)
            .map((chunk) =>
              chunk.type === "chunk" ? chunk.code : String(chunk.source),
            )
            .join(""),
        )
        .digest("hex")
        .slice(0, 12);

      const source = `const CACHE = "plumb-${version}";
const ASSETS = ${JSON.stringify(assets)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Bypass the HTTP cache, so a new version never stores an old page.
      .then((cache) =>
        cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("plumb-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Same-origin GETs only: the app shell. Cache first, network as fallback.
  const key =
    request.mode === "navigate" && !url.pathname.endsWith(".html")
      ? "/"
      : url.pathname;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(key))
      .then((cached) => cached ?? fetch(request)),
  );
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [appShellServiceWorker(), requireAppCheckKey()],
  build: {
    rolldownOptions: {
      input: { main: "index.html", bench: "bench.html" },
    },
  },
});
