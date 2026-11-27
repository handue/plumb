import { getFirebase, missingConfig } from "./firebase";
import {
  onDeviceAvailability,
  prepareOnDeviceModel,
  type Route,
} from "./ai/models";
import { blocker, run, type RunRecord } from "./ai/run";
import { extractionPrompt, parseExtraction, parsePolish } from "./ai/schema";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const envList = byId<HTMLDListElement>("env");
const setupNotice = byId<HTMLParagraphElement>("setup");
const prepareButton = byId<HTMLButtonElement>("prepare");
const prepareStatus = byId<HTMLParagraphElement>("prepare-status");
const noteInput = byId<HTMLTextAreaElement>("note");
const runStatus = byId<HTMLParagraphElement>("run-status");
const logTable = byId<HTMLTableElement>("log");
const logEmpty = byId<HTMLParagraphElement>("log-empty");
const runButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("button[data-route]"),
];

const ROUTE_LABELS: Record<Route, string> = {
  capture: "Structure, device preferred",
  captureCloud: "Structure, cloud only",
  captureOffline: "Structure, device only",
  polish: "Polish in cloud",
  photo: "Photo assist, device only",
};

const SOURCE_LABELS = {
  on_device: "On device",
  in_cloud: "Cloud",
} as const;

const AVAILABILITY_LABELS: Record<string, string> = {
  available: "ready",
  downloadable: "not downloaded yet",
  downloading: "downloading",
  unavailable: "not supported on this device",
  missing: "no Prompt API in this browser",
};

/** The most recent successful extraction, used as input for polish. */
let lastExtraction: { note: string; json: string } | null = null;

let configured = false;
let busy = false;

/** Version of Google Chrome itself, or null in any other browser. */
function chromeVersion(): string | null {
  const brands = (
    navigator as Navigator & {
      userAgentData?: { brands: { brand: string; version: string }[] };
    }
  ).userAgentData?.brands;
  if (!brands?.some((entry) => entry.brand === "Google Chrome")) return null;
  return navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null;
}

function fact(term: string, value: string, state?: "ok" | "bad"): HTMLElement[] {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (state) dd.className = `state-${state}`;
  return [dt, dd];
}

function syncButtons(): void {
  for (const button of [prepareButton, ...runButtons]) {
    button.disabled = !configured || busy;
  }
}

let renderToken = 0;

async function renderEnvironment(): Promise<void> {
  const token = ++renderToken;
  const availability = await onDeviceAvailability();
  // A newer render started while this one was waiting; let it win.
  if (token !== renderToken) return;

  const rows: HTMLElement[] = [];
  const chrome = chromeVersion();
  rows.push(
    ...fact("Chrome", chrome ?? "not Google Chrome", chrome ? undefined : "bad"),
    ...fact(
      "On-device model",
      AVAILABILITY_LABELS[availability] ?? availability,
      availability === "available" ? "ok" : "bad",
    ),
    ...fact(
      "Network",
      navigator.onLine ? "online" : "offline",
      navigator.onLine ? "ok" : "bad",
    ),
  );

  const missing = missingConfig();
  configured = missing.length === 0;
  setupNotice.hidden = configured;

  if (configured) {
    const { app, appCheckMode } = getFirebase();
    rows.push(
      ...fact("Firebase project", app.options.projectId ?? "unknown"),
      ...fact(
        "App Check",
        appCheckMode === "none"
          ? "not set up, cloud calls will fail"
          : appCheckMode,
        appCheckMode === "none" ? "bad" : "ok",
      ),
    );
  } else {
    rows.push(...fact("Firebase", "not configured", "bad"));
    setupNotice.textContent = `Copy .env.example to .env, fill in ${missing.join(", ")}, then restart the dev server.`;
  }

  envList.replaceChildren(...rows);
  syncButtons();
}

function summarize(record: RunRecord): string {
  if (record.error) return record.error;
  if (record.text === null) return "";
  try {
    const parsed =
      record.route === "polish"
        ? parsePolish(record.text)
        : parseExtraction(record.text);
    return JSON.stringify(parsed);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `${reason} Raw output: ${record.text}`;
  }
}

/** Adds one row. Only records returned by run() belong in this table. */
function appendRecord(record: RunRecord): void {
  const row = logTable.tBodies[0].insertRow(0);
  const cell = (text: string, className?: string): void => {
    const td = row.insertCell();
    td.textContent = text;
    if (className) td.className = className;
  };

  cell(
    new Date(record.at).toLocaleTimeString("en-US", { hourCycle: "h23" }),
  );
  cell(ROUTE_LABELS[record.route]);
  cell(
    record.source ? SOURCE_LABELS[record.source] : "Failed",
    `tier-${record.source ?? "failed"}`,
  );
  cell(`${record.ms} ms`, "num");
  cell(record.online ? "online" : "offline");
  cell(summarize(record), "result");

  logTable.hidden = false;
  logEmpty.hidden = true;
}

/**
 * Disables the controls for the duration of a task, then gives keyboard focus
 * back to the button that started it, unless the user has moved elsewhere.
 */
async function whileBusy(
  trigger: HTMLButtonElement,
  task: () => Promise<void>,
): Promise<void> {
  if (busy) return;
  busy = true;
  syncButtons();
  try {
    await task();
  } finally {
    busy = false;
    syncButtons();
    const active = document.activeElement;
    if (!trigger.disabled && (active === null || active === document.body)) {
      trigger.focus();
    }
  }
}

/** Builds the prompt for a route, or explains why there is nothing to send. */
function buildPrompt(
  route: Route,
): { prompt: string; note: string } | { problem: string } {
  const note = noteInput.value.trim();

  if (route !== "polish") {
    if (!note) return { problem: "Write a note first." };
    // The bench has no visit, so the prompt carries a neutral context.
    return {
      note,
      prompt: extractionPrompt(note, {
        visitType: "Site visit",
        hint: "Areas are the places on the site that the note mentions.",
        knownAreas: [],
      }),
    };
  }
  if (!lastExtraction || lastExtraction.note !== note) {
    return {
      problem: "Structure this note first. Polish works on a structured finding.",
    };
  }
  return {
    note,
    prompt: `Visit type: Site visit\nInspector's note: ${lastExtraction.note}\nExtracted finding: ${lastExtraction.json}`,
  };
}

async function handleRun(route: Route): Promise<void> {
  const built = buildPrompt(route);
  if ("problem" in built) {
    runStatus.textContent = built.problem;
    return;
  }

  const blocked = await blocker(route);
  if (blocked) {
    runStatus.textContent = blocked;
    return;
  }

  const label = ROUTE_LABELS[route];
  runStatus.textContent = `Running: ${label}.`;
  let outcome = `${label} did not finish.`;
  try {
    const record = await run(route, built.prompt);
    if (route !== "polish" && record.text !== null) {
      try {
        parseExtraction(record.text);
        lastExtraction = { note: built.note, json: record.text };
      } catch {
        // Invalid output is shown in the log; it is not kept for polish.
      }
    }
    appendRecord(record);
    outcome = record.source
      ? `${label}: answered ${SOURCE_LABELS[record.source].toLowerCase()} in ${record.ms} ms.`
      : `${label} failed: ${record.error}`;
  } finally {
    runStatus.textContent = outcome;
  }
}

async function handlePrepare(): Promise<void> {
  prepareStatus.textContent = "Checking the on-device model.";
  try {
    await prepareOnDeviceModel((fraction) => {
      prepareStatus.textContent = `Downloading the on-device model: ${Math.round(fraction * 100)}%`;
    });
    // The SDK resolves quietly in some unsupported states, so confirm.
    const availability = await onDeviceAvailability();
    prepareStatus.textContent =
      availability === "available"
        ? "On-device model is ready."
        : `On-device model is ${AVAILABILITY_LABELS[availability] ?? availability}.`;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    prepareStatus.textContent = `On-device model could not be prepared: ${reason}`;
  }
  void renderEnvironment();
}

prepareButton.addEventListener("click", () => {
  void whileBusy(prepareButton, handlePrepare);
});

for (const button of runButtons) {
  button.addEventListener("click", () => {
    void whileBusy(button, () => handleRun(button.dataset.route as Route));
  });
}

window.addEventListener("online", () => void renderEnvironment());
window.addEventListener("offline", () => void renderEnvironment());

noteInput.value = noteInput.value.trim();
syncButtons();
void renderEnvironment();
