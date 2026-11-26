import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/barlow/latin-700.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./app.css";

import { missingConfig } from "./firebase";
import {
  onDeviceAvailability,
  prepareOnDeviceModel,
  ROUTE_MODES,
  type Route,
} from "./ai/models";
import { blocker, run } from "./ai/run";
import {
  parseExtraction,
  parsePolish,
  SEVERITIES,
  type Severity,
} from "./ai/schema";
import {
  createPlan,
  ROOM_LABELS,
  toPlanRoom,
  type PlanPin,
  type PlanRoom,
} from "./plan";
import { renderReport, roomLabel } from "./report";
import {
  addCall,
  clearInspection,
  deleteFinding,
  getMeta,
  loadCalls,
  loadFindings,
  saveFinding,
  setMeta,
  type CallRecord,
  type Finding,
} from "./store";

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const siteInput = byId<HTMLInputElement>("site");
const netText = byId<HTMLSpanElement>("net-text");
const simulateSwitch = byId<HTMLInputElement>("simulate");
const notice = byId<HTMLDivElement>("notice");
const noticeText = byId<HTMLParagraphElement>("notice-text");
const noticeAction = byId<HTMLButtonElement>("notice-action");
const planHint = byId<HTMLParagraphElement>("plan-hint");
const planSvg = byId<SVGSVGElement>("plan");
const wave = byId<HTMLDivElement>("wave");
const captureForm = byId<HTMLFormElement>("capture-form");
const noteInput = byId<HTMLInputElement>("note");
const captureStatus = byId<HTMLParagraphElement>("capture-status");
const feedCount = byId<HTMLParagraphElement>("feed-count");
const feedStatus = byId<HTMLParagraphElement>("feed-status");
const feedEmpty = byId<HTMLDivElement>("feed-empty");
const examples = byId<HTMLUListElement>("examples");
const feed = byId<HTMLOListElement>("feed");
const clearButton = byId<HTMLButtonElement>("clear");
const clearDialog = byId<HTMLDialogElement>("clear-dialog");
const clearText = byId<HTMLParagraphElement>("clear-text");
const logSummary = byId<HTMLParagraphElement>("log-summary");
const logEmpty = byId<HTMLParagraphElement>("log-empty");
const logTable = byId<HTMLTableElement>("log");
const captureView = byId<HTMLDivElement>("capture-view");
const reportView = byId<HTMLDivElement>("report-view");
const paper = byId<HTMLElement>("paper");
const printButton = byId<HTMLButtonElement>("print");
const tabCapture = byId<HTMLAnchorElement>("tab-capture");
const tabReport = byId<HTMLAnchorElement>("tab-report");

const DEFAULT_SITE = "Unit 4B, Riverside Apartments";
const SIMULATE_KEY = "plumb.simulateOffline";
const EXAMPLE_NOTES = [
  "kitchen outlet next to sink has no gfci",
  "water stain on bathroom ceiling about 30 cm wide",
  "hairline crack on living room north wall, roughly 16 inches",
];
const TIER_LABELS = { on_device: "on device", in_cloud: "in cloud" } as const;
const LOG_ROWS = 60;

let findings: Finding[] = [];
let calls: CallRecord[] = [];
let selectedId: string | null = null;
let placingId: string | null = null;
let simulated = localStorage.getItem(SIMULATE_KEY) === "1";
let availability = "missing";
let downloading = false;
/** The finding removed last, kept so the delete can be undone. */
let lastDeleted: Finding | null = null;
/** Findings whose card or polish has not been shown yet, for one-off motion. */
const shownCards = new Set<string>();
const freshlyPolished = new Set<string>();

const configured = missingConfig().length === 0;

/** Online for the app's purposes: the browser is online and the demo switch is off. */
function isOnline(): boolean {
  return navigator.onLine && !simulated;
}

function findingById(id: string): Finding | undefined {
  return findings.find((finding) => finding.id === id);
}

/** Turns an SDK error into something an inspector can act on. */
function explain(error: string | null, fallback: string): string {
  if (!error) return fallback;
  if (/app ?check/i.test(error)) {
    return "App Check did not accept this browser, so the cloud refused the call. On localhost, register this browser's debug token in the Firebase console.";
  }
  if (/timed out/i.test(error)) return error;
  if (/fetch|network/i.test(error)) {
    return "The cloud could not be reached. It will be tried again when the connection is back.";
  }
  return error.length > 220 ? `${error.slice(0, 219)}…` : error;
}

// ---------------------------------------------------------------- work queues

/** Runs tasks one at a time, in order. */
function serialQueue(): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch((cause: unknown) => {
      console.error(cause);
    });
  };
}

const structureQueue = serialQueue();
const polishQueue = serialQueue();
/** Steps already waiting in a queue, so a finding is never queued twice. */
const pendingSteps = new Set<string>();

function enqueue(
  queue: (task: () => Promise<void>) => void,
  step: "structure" | "polish",
  id: string,
  task: (id: string) => Promise<void>,
): void {
  const key = `${step}:${id}`;
  if (pendingSteps.has(key)) return;
  pendingSteps.add(key);
  queue(async () => {
    try {
      await task(id);
    } finally {
      pendingSteps.delete(key);
    }
  });
}

async function logCall(
  finding: Finding,
  step: CallRecord["step"],
  route: Route,
  record: Awaited<ReturnType<typeof run>>,
  simulatedOffline: boolean,
): Promise<void> {
  const saved = await addCall({
    at: record.at,
    findingSeq: finding.seq,
    step,
    mode: ROUTE_MODES[route],
    tier: record.source,
    ms: record.ms,
    browserOnline: record.online,
    simulatedOffline,
    error: record.error,
  });
  calls.push(saved);
}

/** Turns a saved note into fields. Leaves it queued if that is not possible now. */
async function structure(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding || finding.status !== "queued") return;

  const simulatedOffline = simulated;
  // With no connection the call must not leave the device, so it is made in
  // device-only mode. Online, the SDK prefers the device and may fall back.
  const route: Route = isOnline() ? "capture" : "captureOffline";

  const blocked = configured
    ? await blocker(route)
    : "Firebase is not configured, so no model can be called.";
  if (blocked) {
    finding.captureError = blocked;
    await saveFinding(finding);
    render();
    return;
  }

  finding.status = "structuring";
  finding.captureError = null;
  render();

  const record = await run(route, finding.note);
  const current = findingById(id);
  if (!current) return;
  await logCall(current, "structure", route, record, simulatedOffline);

  if (record.text === null) {
    current.status = "queued";
    current.captureError = explain(record.error, "The model call failed.");
  } else {
    try {
      current.extraction = parseExtraction(record.text);
      current.extractionTier = record.source;
      current.status = "draft";
    } catch {
      current.status = "queued";
      current.captureError =
        "The model answered, but not in the expected fields.";
    }
  }
  await saveFinding(current);

  if (current.status === "draft") {
    if (!current.pin && placingId === null) startPlacing(current.id);
    if (isOnline()) enqueue(polishQueue, "polish", id, polish);
  }
  render();
}

/** Asks the cloud model for the report sentence, severity and flags. */
async function polish(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding || finding.status !== "draft" || !finding.extraction) return;
  if (!isOnline() || !configured) return;

  const simulatedOffline = simulated;
  finding.status = "polishing";
  finding.polishError = null;
  render();

  const lines = [
    `Inspector's note: ${finding.note}`,
    `Extracted finding: ${JSON.stringify(finding.extraction)}`,
  ];
  if (finding.pin) {
    lines.push(`Room marked on the floor plan: ${finding.pin.room}`);
  }

  const record = await run("polish", lines.join("\n"));
  const current = findingById(id);
  if (!current) return;
  await logCall(current, "polish", "polish", record, simulatedOffline);

  current.status = "draft";
  if (record.text === null) {
    current.polishError = explain(record.error, "The cloud call failed.");
  } else {
    try {
      current.polish = parsePolish(record.text);
      current.status = "polished";
      freshlyPolished.add(current.id);
    } catch {
      current.polishError = "The cloud answered, but not in the expected fields.";
    }
  }
  await saveFinding(current);
  render();
}

/**
 * Moves every finding as far as the current connection allows. With `retry`,
 * steps that failed before are tried again.
 */
function sync(retry: boolean): void {
  for (const finding of findings) {
    if (finding.status === "queued" && (retry || !finding.captureError)) {
      enqueue(structureQueue, "structure", finding.id, structure);
    }
  }
  if (!isOnline()) return;
  for (const finding of findings) {
    if (finding.status === "draft" && (retry || !finding.polishError)) {
      enqueue(polishQueue, "polish", finding.id, polish);
    }
  }
}

// ------------------------------------------------------------------- capture

async function addFinding(note: string): Promise<void> {
  const seq = findings.reduce((max, finding) => Math.max(max, finding.seq), 0) + 1;
  const finding: Finding = {
    id: crypto.randomUUID(),
    seq,
    note,
    createdAt: new Date().toISOString(),
    status: "queued",
    extraction: null,
    extractionTier: null,
    captureError: null,
    pin: null,
    polish: null,
    polishError: null,
  };
  // Save before any model call, so the note survives whatever happens next.
  await saveFinding(finding);
  findings.push(finding);
  selectedId = finding.id;
  captureStatus.textContent = `Finding ${seq} saved on this device.`;
  render();
  enqueue(structureQueue, "structure", finding.id, structure);
}

captureForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const note = noteInput.value.trim();
  if (!note) {
    captureStatus.textContent = "Type a note first.";
    noteInput.focus();
    return;
  }
  noteInput.value = "";
  void addFinding(note);
});

// --------------------------------------------------------------- pin placing

function startPlacing(id: string): void {
  placingId = id;
  selectedId = id;
  render();
}

function stopPlacing(): void {
  placingId = null;
  render();
}

async function placePin(x: number, y: number, room: PlanRoom): Promise<void> {
  const finding = placingId ? findingById(placingId) : undefined;
  placingId = null;
  if (!finding) {
    render();
    return;
  }
  finding.pin = { x, y, room };
  await saveFinding(finding);

  // Offer the next structured finding that still has no pin.
  const next = findings.find((other) => other.extraction && !other.pin);
  if (next) placingId = next.id;
  render();
}

const plan = createPlan(planSvg, {
  onPlace: (x, y, room) => void placePin(x, y, room),
  onSelectPin: (id) => {
    selectedId = id;
    render();
    feed
      .querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  },
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && placingId !== null && !clearDialog.open) {
    stopPlacing();
  }
});

// ------------------------------------------------------------------- network

function describeNetwork(): string {
  if (simulated) return "Offline (simulated): on-device only";
  if (!navigator.onLine) return "Offline: on-device only";
  return "Online: cloud polish on";
}

let hintTimer: ReturnType<typeof setTimeout> | undefined;

function applyNetwork(initial: boolean): void {
  const online = isOnline();
  const before = document.body.dataset.net;
  document.body.dataset.net = online ? "online" : "offline";
  document.body.dataset.simulated = String(simulated);
  netText.textContent = describeNetwork();

  if (initial) return;

  if (before === "offline" && online) {
    // Restart the wave animation.
    wave.classList.remove("is-running");
    void wave.offsetWidth;
    wave.classList.add("is-running");
    sync(true);
  } else if (before === "online" && !online) {
    clearTimeout(hintTimer);
    document.body.dataset.signalLost = "true";
    hintTimer = setTimeout(() => {
      delete document.body.dataset.signalLost;
      render();
    }, 6000);
  }
  render();
}

simulateSwitch.checked = simulated;
simulateSwitch.addEventListener("change", () => {
  simulated = simulateSwitch.checked;
  localStorage.setItem(SIMULATE_KEY, simulated ? "1" : "0");
  applyNetwork(false);
});
window.addEventListener("online", () => applyNetwork(false));
window.addEventListener("offline", () => applyNetwork(false));

// --------------------------------------------------------- on-device notice

async function refreshAvailability(): Promise<void> {
  availability = await onDeviceAvailability();
  renderNotice();
}

function renderNotice(): void {
  let text = "";
  let action = "";

  if (!configured) {
    text = `Firebase is not configured, so no model can be called. Copy .env.example to .env, fill in ${missingConfig().join(", ")}, then restart the dev server. Notes are still saved on this device.`;
  } else if (downloading) {
    text = noticeText.textContent ?? "";
  } else if (availability === "missing") {
    text =
      "This browser has no on-device model. Notes are structured in the cloud while you are online, and wait in the queue while you are offline. Use Chrome desktop 148 or later for on-device capture.";
  } else if (availability === "unavailable") {
    text =
      "This device cannot run the on-device model. Notes are structured in the cloud while you are online, and wait in the queue while you are offline.";
  } else if (availability === "downloadable" || availability === "downloading") {
    text =
      "The on-device model is not downloaded yet. Download it once, while you have a connection, to capture findings offline.";
    action = "Download model";
  }

  notice.hidden = text === "";
  noticeText.textContent = text;
  noticeAction.hidden = action === "" || downloading;
  noticeAction.textContent = action;
}

noticeAction.addEventListener("click", () => {
  if (downloading) return;
  downloading = true;
  noticeText.textContent = "Starting the on-device model download.";
  noticeAction.hidden = true;
  void prepareOnDeviceModel((fraction) => {
    noticeText.textContent = `Downloading the on-device model: ${Math.round(fraction * 100)}%. You can keep capturing.`;
  })
    .then(
      () => undefined,
      (cause: unknown) => {
        captureStatus.textContent = `The on-device model could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}`;
      },
    )
    .then(async () => {
      downloading = false;
      await refreshAvailability();
      sync(true);
    });
});

// ---------------------------------------------------------------- rendering

function pinState(finding: Finding): PlanPin["state"] {
  return finding.polish
    ? (finding.polish.severity.toLowerCase() as PlanPin["state"])
    : "draft";
}

function pinLabel(finding: Finding): string {
  const label = finding.extraction?.item ?? "Finding";
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

function planPins(): PlanPin[] {
  return findings
    .filter((finding) => finding.pin)
    .map((finding) => ({
      id: finding.id,
      seq: finding.seq,
      x: finding.pin!.x,
      y: finding.pin!.y,
      label: pinLabel(finding),
      state: pinState(finding),
    }));
}

/** Worst reviewed severity per room. Rooms with no reviewed finding are absent. */
function heatMap(): Partial<Record<PlanRoom, Severity>> {
  const heat: Partial<Record<PlanRoom, Severity>> = {};
  for (const finding of findings) {
    if (!finding.polish) continue;
    const room = finding.pin?.room ?? toPlanRoom(finding.extraction?.room);
    if (!room) continue;
    const known = heat[room];
    if (
      !known ||
      SEVERITIES.indexOf(finding.polish.severity) > SEVERITIES.indexOf(known)
    ) {
      heat[room] = finding.polish.severity;
    }
  }
  return heat;
}

function renderPlan(): void {
  plan.setPins(planPins(), selectedId);
  plan.setHeat(heatMap());

  const placing = placingId ? findingById(placingId) : undefined;
  const suggested = toPlanRoom(placing?.extraction?.room);
  plan.setPlacing(Boolean(placing), suggested);

  if (placing) {
    planHint.textContent = suggested
      ? `Click the plan to pin finding ${placing.seq}. The note points to the ${ROOM_LABELS[suggested].toLowerCase()}. Press Escape to skip.`
      : `Click the plan to pin finding ${placing.seq}. Press Escape to skip.`;
  } else if (document.body.dataset.signalLost) {
    planHint.textContent =
      "Connection lost. Keep working: notes are structured on this device.";
  } else {
    planHint.textContent = "";
  }
}

function field(term: string, value: string): HTMLElement[] {
  return [el("dt", undefined, term), el("dd", undefined, value)];
}

function actionButton(
  label: string,
  key: string,
  onClick: () => void,
  className = "quiet",
): HTMLButtonElement {
  const button = el("button", className, label);
  button.type = "button";
  button.dataset.focusKey = key;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderCard(finding: Finding): HTMLLIElement {
  const card = el("li", "card");
  card.dataset.id = finding.id;
  card.dataset.status = finding.status;
  if (finding.polish) card.dataset.severity = finding.polish.severity.toLowerCase();
  if (finding.id === selectedId) card.classList.add("is-selected");
  if (!shownCards.has(finding.id)) {
    card.classList.add("is-new");
    shownCards.add(finding.id);
  }
  card.addEventListener("click", () => {
    if (selectedId === finding.id) return;
    selectedId = finding.id;
    render();
  });

  const head = el("div", "card-head");
  head.append(el("span", "card-number", String(finding.seq)));
  const title = el("h3", "card-title");
  title.textContent = finding.extraction
    ? `${roomLabel(finding)}: ${finding.extraction.item}`
    : "New note";
  head.append(title);
  if (finding.polish) {
    const chip = el("span", "chip", finding.polish.severity);
    chip.dataset.key = finding.polish.severity.toLowerCase();
    head.append(chip);
  } else {
    const chip = el("span", "chip", "Draft");
    chip.dataset.key = "draft";
    head.append(chip);
  }
  card.append(head);

  if (finding.polish) {
    const body = el("div", "card-polish");
    if (freshlyPolished.has(finding.id)) body.classList.add("is-fresh");
    body.append(el("p", "card-sentence", finding.polish.sentence));
    const flags: string[] = [];
    if (finding.polish.safety_flag) flags.push("Safety concern");
    if (finding.polish.water_flag) flags.push("Water related");
    if (flags.length > 0) {
      const list = el("ul", "flags");
      for (const flag of flags) list.append(el("li", undefined, flag));
      body.append(list);
    }
    card.append(body);
  } else if (finding.extraction) {
    const { item, issue, size_cm, water_related } = finding.extraction;
    const fields = el("dl", "fields");
    fields.append(
      ...field("room", finding.extraction.room),
      ...field("item", item),
      ...field("issue", issue),
      ...field("size_cm", size_cm === null ? "null" : String(size_cm)),
      ...field("water_related", String(water_related)),
      ...field("severity", "waiting for cloud"),
    );
    card.append(fields);
  } else if (finding.status === "structuring") {
    const skeleton = el("div", "skeleton");
    skeleton.append(el("span"), el("span"), el("span"));
    skeleton.setAttribute("aria-hidden", "true");
    card.append(skeleton);
  }

  card.append(el("p", "card-note", finding.note));

  const steps = el("p", "card-steps");
  const addStep = (text: string, tier?: string): void => {
    const step = el("span", "step", text);
    if (tier) step.dataset.tier = tier;
    steps.append(step);
  };
  if (finding.status === "queued") {
    addStep(finding.captureError ? "Saved, not structured" : "Saved, waiting to be structured");
  } else if (finding.status === "structuring") {
    addStep("Structuring");
  }
  if (finding.extractionTier) {
    addStep(`Structured ${TIER_LABELS[finding.extractionTier]}`, finding.extractionTier);
  }
  if (finding.status === "polishing") {
    addStep("Polishing in cloud", "in_cloud");
  } else if (finding.polish) {
    addStep("Polished in cloud", "in_cloud");
  } else if (finding.status === "draft" && !isOnline()) {
    addStep("Polish waits for a connection");
  }
  card.append(steps);

  const problem = finding.captureError ?? finding.polishError;
  if (problem) {
    card.append(
      el(
        "p",
        "card-problem",
        finding.captureError
          ? `Not structured yet: ${problem}`
          : `Cloud polish failed: ${problem}`,
      ),
    );
  }

  const actions = el("div", "card-actions");
  if (finding.extraction) {
    const isPlacing = placingId === finding.id;
    actions.append(
      actionButton(
        isPlacing ? "Cancel placing" : finding.pin ? "Move pin" : "Place on plan",
        `place:${finding.id}`,
        () => (isPlacing ? stopPlacing() : startPlacing(finding.id)),
      ),
    );
  }
  const canRetry =
    (finding.status === "queued" && finding.captureError !== null) ||
    (finding.status === "draft" && finding.polishError !== null && isOnline());
  if (canRetry) {
    actions.append(
      actionButton("Try again", `retry:${finding.id}`, () => {
        if (finding.status === "queued") {
          enqueue(structureQueue, "structure", finding.id, structure);
        } else {
          enqueue(polishQueue, "polish", finding.id, polish);
        }
      }),
    );
  }
  actions.append(
    actionButton("Delete", `delete:${finding.id}`, () => void removeFinding(finding.id)),
  );
  card.append(actions);

  return card;
}

function renderFeed(): void {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset
    ?.focusKey;

  const newestFirst = [...findings].sort((a, b) => b.seq - a.seq);
  feed.replaceChildren(...newestFirst.map(renderCard));
  freshlyPolished.clear();

  if (focusKey) {
    feed
      .querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      ?.focus();
  }

  const total = findings.length;
  const reviewed = findings.filter((finding) => finding.polish).length;
  feedEmpty.hidden = total > 0;
  clearButton.hidden = total === 0;
  feedCount.textContent =
    total === 0 ? "" : `${total} captured, ${reviewed} reviewed in cloud`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function networkLabel(record: CallRecord): string {
  if (record.simulatedOffline) return "offline (simulated)";
  return record.browserOnline ? "online" : "offline";
}

function renderLog(): void {
  const body = logTable.tBodies[0];
  const rows = [...calls].reverse().slice(0, LOG_ROWS).map((record) => {
    const row = document.createElement("tr");
    const cell = (text: string, className?: string): void => {
      const td = row.insertCell();
      td.textContent = text;
      if (className) td.className = className;
    };
    cell(new Date(record.at).toLocaleTimeString("en-US", { hourCycle: "h23" }));
    cell(`#${record.findingSeq}`);
    cell(record.step === "structure" ? "Structure" : "Polish");
    cell(record.mode, "mode");
    cell(
      record.tier ? (record.tier === "on_device" ? "On device" : "Cloud") : "Failed",
      `tier-${record.tier ?? "failed"}`,
    );
    cell(`${record.ms.toLocaleString("en-US")} ms`, "num");
    cell(networkLabel(record));
    if (record.error) row.title = record.error;
    return row;
  });
  body.replaceChildren(...rows);

  logTable.hidden = calls.length === 0;
  logEmpty.hidden = calls.length > 0;

  const summarize = (tier: "on_device" | "in_cloud", label: string): string | null => {
    const times = calls
      .filter((record) => record.tier === tier)
      .map((record) => record.ms);
    const mid = median(times);
    if (mid === null) return null;
    return `${label}: ${times.length} ${times.length === 1 ? "call" : "calls"}, median ${mid.toLocaleString("en-US")} ms`;
  };
  logSummary.textContent = [
    summarize("on_device", "On device"),
    summarize("in_cloud", "Cloud"),
  ]
    .filter(Boolean)
    .join(". ");
}

function renderView(): void {
  const report = location.hash === "#report";
  document.body.dataset.view = report ? "report" : "capture";
  captureView.hidden = report;
  reportView.hidden = !report;
  tabCapture.toggleAttribute("aria-current", !report);
  tabReport.toggleAttribute("aria-current", report);
  if (report) {
    renderReport(paper, findings, siteInput.value.trim(), planPins());
  }
}

function render(): void {
  renderPlan();
  renderFeed();
  renderLog();
  renderView();
}

// ------------------------------------------------------ delete, undo, clear

async function removeFinding(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding) return;
  findings = findings.filter((other) => other.id !== id);
  if (placingId === id) placingId = null;
  if (selectedId === id) selectedId = null;
  await deleteFinding(id);
  lastDeleted = finding;

  const undo = actionButton("Undo", "undo", () => void undoDelete(), "quiet");
  feedStatus.replaceChildren(`Finding ${finding.seq} deleted. `, undo);
  feedStatus.hidden = false;
  render();
  undo.focus();
}

async function undoDelete(): Promise<void> {
  const finding = lastDeleted;
  if (!finding) return;
  lastDeleted = null;
  // A step that was in flight when the finding was deleted never landed.
  if (finding.status === "structuring") finding.status = "queued";
  if (finding.status === "polishing") finding.status = "draft";
  await saveFinding(finding);
  findings.push(finding);
  findings.sort((a, b) => a.seq - b.seq);
  feedStatus.textContent = `Finding ${finding.seq} restored.`;
  render();
  sync(false);
}

clearButton.addEventListener("click", () => {
  clearText.textContent = `This deletes ${findings.length} ${findings.length === 1 ? "finding" : "findings"} and the routing log from this device. It cannot be undone.`;
  clearDialog.returnValue = "cancel";
  clearDialog.showModal();
});

clearDialog.addEventListener("close", () => {
  if (clearDialog.returnValue !== "confirm") return;
  void (async () => {
    await clearInspection();
    findings = [];
    calls = [];
    selectedId = null;
    placingId = null;
    lastDeleted = null;
    feedStatus.hidden = true;
    captureStatus.textContent = "";
    render();
    noteInput.focus();
  })();
});

// --------------------------------------------------------------------- start

for (const note of EXAMPLE_NOTES) {
  const item = el("li");
  const button = el("button", "example", note);
  button.type = "button";
  button.addEventListener("click", () => {
    noteInput.value = note;
    noteInput.focus();
  });
  item.append(button);
  examples.append(item);
}

siteInput.addEventListener("change", () => {
  void setMeta("site", siteInput.value.trim());
});

printButton.addEventListener("click", () => window.print());
// Printing from the capture view still prints the report.
window.addEventListener("beforeprint", () => {
  renderReport(paper, findings, siteInput.value.trim(), planPins());
});
window.addEventListener("hashchange", renderView);

async function start(): Promise<void> {
  applyNetwork(true);
  siteInput.value = DEFAULT_SITE;

  try {
    const [storedFindings, storedCalls, site] = await Promise.all([
      loadFindings(),
      loadCalls(),
      getMeta("site"),
    ]);
    findings = storedFindings;
    calls = storedCalls;
    if (site !== undefined) siteInput.value = site;
  } catch (cause) {
    captureStatus.textContent = `Saved findings could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`;
  }

  // A step that was in flight when the page closed never landed.
  for (const finding of findings) {
    if (finding.status === "structuring") finding.status = "queued";
    if (finding.status === "polishing") finding.status = "draft";
    shownCards.add(finding.id);
  }

  render();
  await refreshAvailability();
  sync(true);
}

void start();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
