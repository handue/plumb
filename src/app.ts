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
  extractionPrompt,
  GENERAL_AREA,
  parseExtraction,
  parsePolish,
  SEVERITIES,
  type Severity,
} from "./ai/schema";
import { computeKpis } from "./kpi";
import { createMap, type MapPin, type MapTile } from "./map";
import { isQuotaError, scaleFile, scaleVideoFrame, type ScaledImage } from "./photos";
import { CUSTOM_PRESET_ID, presetById, PRESETS, type Preset } from "./presets";
import { renderReport } from "./report";
import {
  addCall,
  clearVisit,
  deleteArea,
  deleteFinding,
  deletePhoto,
  deletePhotosOf,
  loadAreas,
  loadCalls,
  loadFindings,
  loadPhotos,
  loadVisit,
  onStoreBlocked,
  saveArea,
  saveFinding,
  savePhoto,
  saveVisit,
  type Area,
  type AreaOrigin,
  type CallRecord,
  type Finding,
  type Photo,
  type Visit,
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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const visitBar = byId<HTMLDivElement>("visit-bar");
const siteInput = byId<HTMLInputElement>("site");
const visitType = byId<HTMLSpanElement>("visit-type");
const viewTabs = byId<HTMLElement>("views");
const queueText = byId<HTMLParagraphElement>("queue");
const netText = byId<HTMLSpanElement>("net-text");
const simulateSwitch = byId<HTMLInputElement>("simulate");
const notice = byId<HTMLDivElement>("notice");
const noticeText = byId<HTMLParagraphElement>("notice-text");
const noticeAction = byId<HTMLButtonElement>("notice-action");
const setupView = byId<HTMLFormElement>("setup-view");
const setupSite = byId<HTMLInputElement>("setup-site");
const setupPresets = byId<HTMLDivElement>("setup-presets");
const setupCustom = byId<HTMLDivElement>("setup-custom");
const setupCustomLabel = byId<HTMLInputElement>("setup-custom-label");
const setupStatus = byId<HTMLParagraphElement>("setup-status");
const tilesHost = byId<HTMLDivElement>("tiles");
const mapEmpty = byId<HTMLDivElement>("map-empty");
const lostPlate = byId<HTMLParagraphElement>("lost");
const wave = byId<HTMLDivElement>("wave");
const addAreaButton = byId<HTMLButtonElement>("add-area");
const suggestions = byId<HTMLDivElement>("suggestions");
const suggestionList = byId<HTMLUListElement>("suggestion-list");
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
const kpiList = byId<HTMLDListElement>("kpis");
const logEmpty = byId<HTMLParagraphElement>("log-empty");
const logTable = byId<HTMLTableElement>("log");
const captureView = byId<HTMLDivElement>("capture-view");
const reportView = byId<HTMLDivElement>("report-view");
const paper = byId<HTMLElement>("paper");
const printButton = byId<HTMLButtonElement>("print");
const tabCapture = byId<HTMLAnchorElement>("tab-capture");
const tabReport = byId<HTMLAnchorElement>("tab-report");
const photoInput = byId<HTMLInputElement>("photo-input");
const cameraDialog = byId<HTMLDialogElement>("camera-dialog");
const cameraVideo = byId<HTMLVideoElement>("camera-video");
const cameraStatus = byId<HTMLParagraphElement>("camera-status");
const cameraShoot = byId<HTMLButtonElement>("camera-shoot");
const cameraClose = byId<HTMLButtonElement>("camera-close");
const photoDialog = byId<HTMLDialogElement>("photo-dialog");
const photoTitle = byId<HTMLHeadingElement>("photo-title");
const photoFrame = byId<HTMLDivElement>("photo-frame");
const photoRemove = byId<HTMLButtonElement>("photo-remove");
const photoClose = byId<HTMLButtonElement>("photo-close");

const SIMULATE_KEY = "plumb.simulateOffline";
const DEFAULT_PRESET_ID = "warehouse";
const TIER_LABELS = { on_device: "on device", in_cloud: "in cloud" } as const;
const LOG_ROWS = 60;

let visit: Visit | null = null;
let areas: Area[] = [];
let findings: Finding[] = [];
let calls: CallRecord[] = [];
/** Photos per finding id. */
const photos = new Map<string, Photo[]>();
/** Object URLs for stored photos, made on demand and revoked on removal. */
const photoUrls = new Map<string, string>();

let selectedId: string | null = null;
let simulated = localStorage.getItem(SIMULATE_KEY) === "1";
let availability = "missing";
let downloading = false;
/** The finding removed last, kept so the delete can be undone. */
let lastDeleted: Finding | null = null;
/**
 * When each card first appeared and when each polish landed. The feed is
 * rebuilt on every render, so a rebuilt card continues its animation from
 * these times instead of restarting or losing it.
 */
const cardShownAt = new Map<string, number>();
const polishedAt = new Map<string, number>();
const CARD_IN_MS = 320;
const POLISH_IN_MS = 620;
/** What the capture line says when it has nothing more specific to say. */
let deviceNote = "";

/** Bumped when the visit is cleared, so calls from before it are dropped. */
let generation = 0;

const configured = missingConfig().length === 0;
const encoder = new TextEncoder();

/** Online for the app's purposes: the browser is online and the demo switch is off. */
function isOnline(): boolean {
  return navigator.onLine && !simulated;
}

function findingById(id: string): Finding | undefined {
  return findings.find((finding) => finding.id === id);
}

function areaById(id: string | null): Area | undefined {
  return id === null ? undefined : areas.find((area) => area.id === id);
}

function preset(): Preset {
  return presetById(visit?.presetId);
}

function photosOf(findingId: string): Photo[] {
  return photos.get(findingId) ?? [];
}

function photoUrl(photo: Photo): string {
  let url = photoUrls.get(photo.id);
  if (!url) {
    url = URL.createObjectURL(photo.blob);
    photoUrls.set(photo.id, url);
  }
  return url;
}

function forgetPhotoUrl(photoId: string): void {
  const url = photoUrls.get(photoId);
  if (url) URL.revokeObjectURL(url);
  photoUrls.delete(photoId);
}

function showCaptureStatus(text = ""): void {
  captureStatus.textContent = text || deviceNote;
}

function showFeedStatus(...content: (string | Node)[]): void {
  feedStatus.replaceChildren(...content);
  feedStatus.hidden = content.length === 0;
}

/** Turns an SDK error into something an inspector can act on. */
function explain(error: string | null, fallback: string): string {
  if (!error) return fallback;
  if (/^No answer after/.test(error)) return error;
  if (/app ?check/i.test(error)) {
    return "App Check did not accept this browser, so the cloud refused the call. On localhost, register this browser's debug token in the Firebase console.";
  }
  if (/fetch|network/i.test(error)) {
    return "The cloud could not be reached. It will be tried again when the connection is back.";
  }
  return error.length > 220 ? `${error.slice(0, 219)}…` : error;
}

// ---------------------------------------------------------------------- areas

/** Key that decides whether two area names are the same place. */
function areaKey(name: string): string {
  const key = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^the\s+/, "")
    // A sign or decimal point before a digit tells "Level -1" from "Level 1".
    .replace(/[-.](?=\d)/g, "\u0001")
    .replace(/[^\p{L}\p{N}\u0001]+/gu, "");
  // A name made only of symbols still has to match itself.
  return key || name.trim().toLowerCase();
}

const AREA_NAME_LIMIT = 40;

/** Tidies a typed or extracted area name for display. */
function cleanAreaName(raw: string): string {
  let name = raw.replace(/\s+/g, " ").trim();
  if (name.length > AREA_NAME_LIMIT) {
    const cut = name.lastIndexOf(" ", AREA_NAME_LIMIT);
    name = name.slice(0, cut > 0 ? cut : AREA_NAME_LIMIT).trim();
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What a small model writes when it has no area to give. */
const NO_AREA =
  /^(none|null|n\/?a|unknown|unspecified|not (specified|stated|given|mentioned))$/i;

function findArea(name: string): Area | undefined {
  const key = areaKey(name);
  return key === "" ? undefined : areas.find((area) => areaKey(area.name) === key);
}

async function createArea(name: string, origin: AreaOrigin): Promise<Area> {
  const area: Area = {
    id: crypto.randomUUID(),
    name,
    origin,
    createdAt: new Date().toISOString(),
  };
  areas.push(area);
  await saveArea(area);
  return area;
}

/** The area with this name, created if the site has none like it yet. */
async function ensureArea(raw: string, origin: AreaOrigin): Promise<Area> {
  let name = cleanAreaName(raw);
  if (name === "" || NO_AREA.test(name)) name = GENERAL_AREA;
  return findArea(name) ?? createArea(name, origin);
}

/** Area names the capture prompt offers the model, so names stay consistent. */
function knownAreaNames(): string[] {
  const names = areas.map((area) => area.name);
  for (const suggestion of preset().areas) {
    if (!names.some((name) => areaKey(name) === areaKey(suggestion))) {
      names.push(suggestion);
    }
  }
  return names;
}

async function addBlankArea(): Promise<Area> {
  let name = "New area";
  for (let n = 2; findArea(name); n++) name = `New area ${n}`;
  return createArea(name, "manual");
}

/**
 * The cloud sentence was written for the area the finding was in. Once the
 * finding is filed elsewhere it goes back to draft and is polished again.
 */
function refile(finding: Finding, areaId: string): void {
  finding.areaId = areaId;
  finding.areaSetByUser = true;
  if (finding.polish) {
    finding.polish = null;
    finding.polishError = null;
    finding.status = "draft";
  }
}

async function renameArea(areaId: string, raw: string): Promise<void> {
  const area = areaById(areaId);
  if (!area) return;
  const name = cleanAreaName(raw);
  if (name === "" || name === area.name) {
    render();
    return;
  }
  const twin = findArea(name);
  if (twin && twin !== area) {
    // Two tiles for one place: fold this one into the other.
    const moved = findings.filter((finding) => finding.areaId === area.id);
    for (const finding of moved) refile(finding, twin.id);
    areas = areas.filter((other) => other !== area);
    await Promise.all([...moved.map(saveFinding), deleteArea(area.id)]);
    showFeedStatus(
      `Merged into ${twin.name}: ${plural(moved.length, "finding")} moved.`,
    );
    sync(false);
  } else {
    area.name = name;
    await saveArea(area);
  }
  render();
}

async function removeArea(areaId: string): Promise<void> {
  if (findings.some((finding) => finding.areaId === areaId)) return;
  areas = areas.filter((area) => area.id !== areaId);
  await deleteArea(areaId);
  render();
}

async function moveFinding(findingId: string, areaId: string): Promise<void> {
  const finding = findingById(findingId);
  if (!finding || !areaById(areaId) || finding.areaId === areaId) return;
  refile(finding, areaId);
  await saveFinding(finding);
  render();
  sync(false);
}

addAreaButton.addEventListener("click", () => {
  void addBlankArea().then((area) => {
    render();
    map.editName(area.id);
  });
});

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
  findingSeq: number,
  step: CallRecord["step"],
  route: Route,
  prompt: string,
  record: Awaited<ReturnType<typeof run>>,
  simulatedOffline: boolean,
): Promise<void> {
  const log = calls;
  const saved = await addCall({
    at: record.at,
    findingSeq,
    step,
    mode: ROUTE_MODES[route],
    tier: record.source,
    ms: record.ms,
    promptBytes: encoder.encode(prompt).length,
    browserOnline: record.online,
    simulatedOffline,
    error: record.error,
  });
  // Skip the in-memory row if the visit was cleared during the write.
  if (log === calls) calls.push(saved);
}

/** Turns a saved note into fields. Leaves it queued if that is not possible now. */
async function structure(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding || finding.status !== "queued" || !visit) return;

  const simulatedOffline = simulated;
  const offline = !isOnline();
  // With no connection the call must not leave the device, so it is made in
  // device-only mode. Online, the SDK prefers the device and may fall back.
  const route: Route = offline ? "captureOffline" : "capture";

  const blocked = configured
    ? await blocker(route)
    : "Firebase is not configured, so no model can be called.";
  if (findingById(id) !== finding) return;
  if (blocked) {
    finding.captureError = blocked;
    await saveFinding(finding);
    render();
    return;
  }

  finding.status = "structuring";
  finding.captureError = null;
  render();

  const prompt = extractionPrompt(finding.note, {
    visitType: visit.typeLabel,
    hint: preset().hint,
    knownAreas: knownAreaNames(),
  });
  const started = generation;
  const record = await run(route, prompt);
  if (started !== generation) return;
  // The call happened, so it is logged even if the finding was deleted.
  await logCall(finding.seq, "structure", route, prompt, record, simulatedOffline);
  const current = findingById(id);
  if (current !== finding) {
    render();
    return;
  }

  if (record.text === null) {
    current.status = "queued";
    current.captureError = explain(record.error, "The model call failed.");
  } else {
    try {
      current.extraction = parseExtraction(record.text);
      current.extractionTier = record.source;
      current.extractedOffline = offline;
      // Offline only because of the demo control, not for real.
      current.extractedSimulated = offline && simulatedOffline && record.online;
      current.status = "draft";
    } catch {
      current.status = "queued";
      current.captureError =
        "The model answered, but not in the expected fields.";
    }
  }

  // File the finding under the area the model read from the note, unless the
  // inspector already filed it by hand.
  if (current.extraction && !current.areaSetByUser) {
    const area = await ensureArea(current.extraction.area, "note");
    current.areaId = area.id;
  }
  // The finding may have been deleted, or the visit cleared, meanwhile.
  if (started !== generation) return;
  if (findingById(id) !== current) {
    render();
    return;
  }
  await saveFinding(current);

  if (current.status === "draft" && isOnline()) {
    enqueue(polishQueue, "polish", id, polish);
  }
  render();
}

/** Asks the cloud model for the report sentence, severity and flags. */
async function polish(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding || finding.status !== "draft" || !finding.extraction || !visit) {
    return;
  }
  if (!isOnline() || !configured) return;

  const simulatedOffline = simulated;
  finding.status = "polishing";
  finding.polishError = null;
  render();

  const areaAtStart = finding.areaId;
  const areaName = areaById(finding.areaId)?.name ?? finding.extraction.area;
  const prompt = [
    `Visit type: ${visit.typeLabel}`,
    `Area: ${areaName}`,
    `Inspector's note: ${finding.note}`,
    // The area the finding is filed under, which may not be the extracted one.
    `Extracted finding: ${JSON.stringify({ ...finding.extraction, area: areaName })}`,
  ].join("\n");

  const started = generation;
  const record = await run("polish", prompt);
  if (started !== generation) return;
  await logCall(finding.seq, "polish", "polish", prompt, record, simulatedOffline);
  const current = findingById(id);
  if (current !== finding) {
    render();
    return;
  }

  current.status = "draft";
  if (current.areaId !== areaAtStart) {
    // Refiled while the call was in flight: the sentence is for the old area.
    await saveFinding(current);
    render();
    sync(false);
    return;
  }
  if (!isOnline()) {
    // The app went offline while the call was in flight. The call is in the
    // log, but its result is not applied while the app says it is offline.
    // Polish runs again on reconnect.
    await saveFinding(current);
    render();
    return;
  }
  if (record.text === null) {
    current.polishError = explain(record.error, "The cloud call failed.");
  } else {
    try {
      current.polish = parsePolish(record.text);
      current.status = "polished";
      polishedAt.set(current.id, performance.now());
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
  if (!visit) return;
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
  // Never reuse a number: not a deleted finding's, nor one the log refers to.
  const seq =
    Math.max(
      0,
      lastDeleted?.seq ?? 0,
      ...findings.map((finding) => finding.seq),
      ...calls.map((record) => record.findingSeq),
    ) + 1;
  const finding: Finding = {
    id: crypto.randomUUID(),
    seq,
    note,
    createdAt: new Date().toISOString(),
    status: "queued",
    extraction: null,
    extractionTier: null,
    extractedOffline: false,
    extractedSimulated: false,
    captureError: null,
    areaId: null,
    areaSetByUser: false,
    polish: null,
    polishError: null,
  };
  // Save before any model call, so the note survives whatever happens next.
  await saveFinding(finding);
  findings.push(finding);
  selectedId = finding.id;
  showCaptureStatus(`Finding ${seq} saved on this device.`);
  render();
  enqueue(structureQueue, "structure", finding.id, structure);
}

captureForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const note = noteInput.value.trim();
  if (!note) {
    showCaptureStatus("Type a note first.");
    noteInput.focus();
    return;
  }
  noteInput.value = "";
  void addFinding(note).catch((cause: unknown) => {
    // The note never reached storage: hand it back instead of losing it.
    if (noteInput.value.trim() === "") noteInput.value = note;
    showCaptureStatus(
      isQuotaError(cause)
        ? "This device is out of storage, so the note was not saved. Remove photos or findings you no longer need, then try again."
        : `The note was not saved: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    noteInput.focus();
  });
});

// -------------------------------------------------------------------- photos

const QUOTA_MESSAGE =
  "This device is out of storage, so the photo was not saved. Remove photos or findings you no longer need, then try again.";

const FINDING_GONE = "The finding was removed, so the photo was not kept.";

/** `startedIn` is the visit generation when the photo was picked or taken. */
async function storePhoto(
  findingId: string,
  image: ScaledImage,
  startedIn: number,
): Promise<Photo> {
  const wanted = (): boolean =>
    generation === startedIn &&
    (findingById(findingId) !== undefined || lastDeleted?.id === findingId);
  if (!wanted()) throw new Error(FINDING_GONE);
  const photo: Photo = {
    id: crypto.randomUUID(),
    findingId,
    blob: image.blob,
    width: image.width,
    height: image.height,
    createdAt: new Date().toISOString(),
  };
  await savePhoto(photo);
  if (!wanted()) {
    await deletePhoto(photo.id).catch(() => undefined);
    throw new Error(FINDING_GONE);
  }
  photos.set(findingId, [...photosOf(findingId), photo]);
  return photo;
}

function photoProblem(cause: unknown): string {
  if (isQuotaError(cause)) return QUOTA_MESSAGE;
  return `The photo was not saved: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** Downscales and stores picked files, one at a time, and reports the outcome. */
async function attachFiles(findingId: string, files: File[]): Promise<void> {
  const finding = findingById(findingId);
  if (!finding || files.length === 0) return;
  const startedIn = generation;
  let saved = 0;
  let problem = "";
  for (const file of files) {
    try {
      await storePhoto(findingId, await scaleFile(file), startedIn);
      saved += 1;
    } catch (cause) {
      problem = photoProblem(cause);
      if (isQuotaError(cause)) break;
    }
    // The visit was cleared while a file was being scaled.
    if (generation !== startedIn) return;
  }
  const done =
    saved > 0
      ? `${plural(saved, "photo")} saved on this device for finding ${finding.seq}.`
      : "";
  showFeedStatus([done, problem].filter(Boolean).join(" "));
  render();
}

/** The finding the hidden file input or the camera is collecting photos for. */
let photoTargetId: string | null = null;

photoInput.addEventListener("change", () => {
  const files = [...(photoInput.files ?? [])];
  photoInput.value = "";
  if (photoTargetId) void attachFiles(photoTargetId, files);
});

let cameraStream: MediaStream | null = null;
/** Bumped on every open and close, so a late permission answer is dropped. */
let cameraSession = 0;
/** Where keyboard focus goes back to when a dialog closes. */
let returnFocusKeys: string[] = [];

function restoreFeedFocus(): void {
  for (const key of returnFocusKeys) {
    const target = feed.querySelector<HTMLElement>(
      `[data-focus-key="${CSS.escape(key)}"]`,
    );
    if (target) {
      target.focus();
      break;
    }
  }
  returnFocusKeys = [];
}

function stopCamera(): void {
  cameraSession += 1;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
}

async function openCamera(findingId: string): Promise<void> {
  const finding = findingById(findingId);
  if (!finding) return;
  photoTargetId = findingId;
  returnFocusKeys = [`camera:${findingId}`, `card:${findingId}`];
  cameraShoot.disabled = true;
  cameraStatus.textContent = "Starting the camera.";
  cameraDialog.showModal();
  const session = ++cameraSession;

  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent =
      "This browser cannot open a camera here. Use Add photo to pick a file.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 } },
    });
    // The dialog may have been closed, or reopened, while the permission
    // prompt was up.
    if (session !== cameraSession || !cameraDialog.open) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    cameraVideo.srcObject = stream;
    // The button waits for the first frame, so it never captures a blank.
    cameraVideo.addEventListener(
      "loadeddata",
      () => {
        if (cameraStream !== stream) return;
        cameraShoot.disabled = false;
        cameraStatus.textContent = `Photos are saved on this device for finding ${finding.seq}.`;
      },
      { once: true },
    );
  } catch (cause) {
    if (session !== cameraSession) return;
    const name = cause instanceof DOMException ? cause.name : "";
    cameraStatus.textContent =
      name === "NotAllowedError"
        ? "Camera access was blocked. Allow the camera for this site, or use Add photo to pick a file."
        : name === "NotFoundError"
          ? "No camera was found. Use Add photo to pick a file."
          : `The camera could not be started: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

cameraShoot.addEventListener("click", () => {
  const findingId = photoTargetId;
  if (!findingId || !findingById(findingId)) return;
  cameraShoot.disabled = true;
  const startedIn = generation;
  void scaleVideoFrame(cameraVideo)
    .then((image) => storePhoto(findingId, image, startedIn))
    .then(
      () => {
        if (generation !== startedIn) return;
        cameraStatus.textContent = `Photo saved. ${plural(photosOf(findingId).length, "photo")} on this finding.`;
        render();
      },
      (cause: unknown) => {
        cameraStatus.textContent = photoProblem(cause);
      },
    )
    .finally(() => {
      cameraShoot.disabled =
        cameraStream === null ||
        cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
    });
});
cameraClose.addEventListener("click", () => cameraDialog.close());
cameraDialog.addEventListener("close", () => {
  stopCamera();
  restoreFeedFocus();
});

/** The photo shown in the viewer. */
let viewedPhoto: Photo | null = null;

function openPhoto(photo: Photo, finding: Finding, index: number): void {
  viewedPhoto = photo;
  returnFocusKeys = [
    `photo:${photo.id}`,
    `photo-add:${finding.id}`,
    `card:${finding.id}`,
  ];
  photoTitle.textContent = `Finding ${finding.seq}, photo ${index + 1}`;
  const image = el("img", "photo-large");
  image.src = photoUrl(photo);
  image.width = photo.width;
  image.height = photo.height;
  image.alt = `Photo ${index + 1} attached to finding ${finding.seq}`;
  photoFrame.replaceChildren(image);
  photoDialog.showModal();
}

photoClose.addEventListener("click", () => photoDialog.close());
photoDialog.addEventListener("close", () => {
  // A removal re-renders first, then restores focus itself.
  if (viewedPhoto) restoreFeedFocus();
  viewedPhoto = null;
  photoFrame.replaceChildren();
});
photoRemove.addEventListener("click", () => {
  const photo = viewedPhoto;
  if (!photo) return;
  viewedPhoto = null;
  photoDialog.close();
  photos.set(
    photo.findingId,
    photosOf(photo.findingId).filter((other) => other.id !== photo.id),
  );
  forgetPhotoUrl(photo.id);
  void deletePhoto(photo.id).then(() => {
    showFeedStatus("Photo removed.");
    render();
    restoreFeedFocus();
  });
});

// ------------------------------------------------------------------- network

function describeNetwork(): string {
  if (isOnline()) {
    return configured ? "Online: cloud polish on" : "Online: cloud not configured";
  }
  const label = simulated && navigator.onLine ? "Offline (simulated)" : "Offline";
  return availability === "available" && configured
    ? `${label}: on-device only`
    : `${label}: notes saved, not structured`;
}

let lostTimer: ReturnType<typeof setTimeout> | undefined;

function applyNetwork(initial: boolean): void {
  const online = isOnline();
  const before = document.body.dataset.net;
  document.body.dataset.net = online ? "online" : "offline";
  netText.textContent = describeNetwork();

  if (initial) return;

  if (before === "offline" && online) {
    clearTimeout(lostTimer);
    lostPlate.textContent = "";
    // Restart the wave animation.
    wave.classList.remove("is-running");
    void wave.offsetWidth;
    wave.classList.add("is-running");
    sync(true);
  } else if (before === "online" && !online) {
    clearTimeout(lostTimer);
    // The demo control is not a lost signal, and the plate says so.
    const lead = simulated && navigator.onLine ? "Offline simulated." : "Signal lost.";
    lostPlate.textContent =
      availability === "available" && configured
        ? `${lead} Keep working: notes are structured on this device.`
        : `${lead} Keep working: notes are saved on this device.`;
    lostTimer = setTimeout(() => {
      lostPlate.textContent = "";
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
  netText.textContent = describeNetwork();
  renderNotice();
}

function renderNotice(): void {
  let text = "";
  let action = "";
  let note = "";

  if (!configured) {
    text = `Firebase is not configured, so no model can be called. Copy .env.example to .env, fill in ${missingConfig().join(", ")}, then restart the dev server. Notes are still saved on this device.`;
  } else if (downloading) {
    text = noticeText.textContent ?? "";
  } else if (availability === "missing") {
    note =
      "No on-device model in this browser: notes are structured in the cloud, or wait while offline. Needs Chrome 148+.";
  } else if (availability === "unavailable") {
    note =
      "This device cannot run the on-device model: notes are structured in the cloud, or wait while offline.";
  } else if (availability === "downloadable" || availability === "downloading") {
    text =
      "The on-device model is not downloaded yet. Download it once, while you have a connection, to capture findings offline.";
    action = "Download model";
  }

  notice.hidden = text === "";
  noticeText.textContent = text;
  noticeAction.hidden = action === "" || downloading;
  noticeAction.textContent = action;

  const showingDefault =
    captureStatus.textContent === "" || captureStatus.textContent === deviceNote;
  deviceNote = note;
  if (showingDefault) showCaptureStatus();
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
        showCaptureStatus(
          `The on-device model could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      },
    )
    .then(async () => {
      downloading = false;
      await refreshAvailability();
      sync(true);
    });
});

// ---------------------------------------------------------------- rendering

function pinState(finding: Finding): MapPin["state"] {
  return finding.polish
    ? (finding.polish.severity.toLowerCase() as MapPin["state"])
    : "draft";
}

function pinLabel(finding: Finding): string {
  const label = finding.extraction?.item ?? "Finding";
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function mapTiles(): MapTile[] {
  return areas.map((area) => {
    const inArea = findings.filter((finding) => finding.areaId === area.id);
    let heat: Severity | null = null;
    for (const finding of inArea) {
      const severity = finding.polish?.severity;
      if (
        severity &&
        (!heat || SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(heat))
      ) {
        heat = severity;
      }
    }
    return {
      area,
      heat,
      pins: inArea.map((finding) => ({
        id: finding.id,
        seq: finding.seq,
        label: pinLabel(finding),
        state: pinState(finding),
      })),
    };
  });
}

function selectFinding(id: string, scrollCard: boolean): void {
  selectedId = id;
  render();
  if (scrollCard) {
    feed
      .querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
}

const map = createMap(tilesHost, {
  onRename: (areaId, name) => void renameArea(areaId, name),
  onRemove: (areaId) => void removeArea(areaId),
  onSelectPin: (id) => selectFinding(id, true),
  onMove: (findingId, areaId) => void moveFinding(findingId, areaId),
});

function renderMap(): void {
  map.update(mapTiles(), selectedId);
  mapEmpty.hidden = areas.length > 0;

  const open = preset().areas.filter((name) => !findArea(name));
  suggestions.hidden = open.length === 0;
  suggestionList.replaceChildren(
    ...open.map((name) => {
      const item = el("li");
      const button = el("button", "suggestion", name);
      button.type = "button";
      button.setAttribute("aria-label", `Add area ${name}`);
      button.addEventListener("click", () => {
        void ensureArea(name, "preset").then(render);
      });
      item.append(button);
      return item;
    }),
  );
}

function field(term: string, value: string): HTMLElement {
  const pair = el("div");
  pair.append(el("dt", undefined, term), el("dd", undefined, value));
  return pair;
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

/** Set when the card holding a focused Area dropdown may be rebuilt. */
let releaseHeldCard = false;

/** A select that files the finding under another area. */
function areaSelect(finding: Finding): HTMLLabelElement {
  const label = el("label", "area-select");
  label.append(el("span", undefined, "Area"));
  const select = el("select");
  select.dataset.focusKey = `area:${finding.id}`;
  if (finding.areaId === null) {
    const none = el("option", undefined, "Not filed");
    none.value = "";
    select.append(none);
  }
  for (const area of areas) {
    const option = el("option", undefined, area.name);
    option.value = area.id;
    select.append(option);
  }
  select.value = finding.areaId ?? "";
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    releaseHeldCard = true;
    if (select.value) void moveFinding(finding.id, select.value);
    else renderFeed();
  });
  // A card kept alive for an open dropdown is stale: rebuild it on leaving.
  select.addEventListener("blur", () => {
    queueMicrotask(() => {
      if (!select.isConnected) return;
      releaseHeldCard = true;
      renderFeed();
    });
  });
  label.append(select);
  return label;
}

function renderCard(finding: Finding): HTMLLIElement {
  const card = el("li", "card");
  card.dataset.id = finding.id;
  card.dataset.status = finding.status;
  if (finding.polish) card.dataset.severity = finding.polish.severity.toLowerCase();
  if (finding.id === selectedId) card.classList.add("is-selected");
  const now = performance.now();
  if (!cardShownAt.has(finding.id)) cardShownAt.set(finding.id, now);
  const cardAge = now - (cardShownAt.get(finding.id) ?? now);
  if (cardAge < CARD_IN_MS) {
    card.classList.add("is-new");
    card.style.animationDelay = `-${Math.round(cardAge)}ms`;
  }
  card.addEventListener("click", () => {
    if (selectedId === finding.id) return;
    selectFinding(finding.id, false);
  });

  const area = areaById(finding.areaId);
  const head = el("div", "card-head");
  head.append(el("span", "card-number", String(finding.seq)));
  const title = el("h3", "card-title");
  // The title is the keyboard way to open a card's actions.
  const toggle = el(
    "button",
    "card-toggle",
    finding.extraction
      ? `${area?.name ?? "Not filed"}: ${finding.extraction.item}`
      : "New note",
  );
  toggle.type = "button";
  toggle.dataset.focusKey = `card:${finding.id}`;
  toggle.setAttribute("aria-expanded", String(finding.id === selectedId));
  title.append(toggle);
  head.append(title);
  const chip = el("span", "chip", finding.polish?.severity ?? "Draft");
  chip.dataset.key = finding.polish
    ? finding.polish.severity.toLowerCase()
    : "draft";
  head.append(chip);
  card.append(head);

  if (finding.polish) {
    const body = el("div", "card-polish");
    const polishAge = now - (polishedAt.get(finding.id) ?? -POLISH_IN_MS);
    if (polishAge < POLISH_IN_MS) {
      body.classList.add("is-fresh");
      body.style.animationDelay = `-${Math.round(polishAge)}ms`;
    }
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
      field("area", finding.extraction.area),
      field("item", item),
      field("issue", issue),
      field("size_cm", size_cm === null ? "null" : String(size_cm)),
      field("water_related", String(water_related)),
      field("severity", "waiting for cloud"),
    );
    card.append(fields);
  } else if (finding.status === "structuring") {
    const skeleton = el("div", "skeleton");
    skeleton.append(el("span"), el("span"), el("span"));
    skeleton.setAttribute("aria-hidden", "true");
    card.append(skeleton);
  }

  card.append(el("p", "card-note", finding.note));

  const attached = photosOf(finding.id);
  if (attached.length > 0) {
    const strip = el("ul", "thumbs");
    attached.forEach((photo, index) => {
      const item = el("li");
      const button = el("button", "thumb");
      button.type = "button";
      button.dataset.focusKey = `photo:${photo.id}`;
      const image = el("img");
      image.src = photoUrl(photo);
      image.alt = `Photo ${index + 1} of finding ${finding.seq}`;
      image.width = 64;
      image.height = 64;
      button.append(image);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openPhoto(photo, finding, index);
      });
      item.append(button);
      strip.append(item);
    });
    card.append(strip);
  }

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
    addStep(
      `Structured ${TIER_LABELS[finding.extractionTier]}${finding.extractedOffline ? (finding.extractedSimulated ? ", offline (simulated)" : ", offline") : ""}`,
      finding.extractionTier,
    );
  }
  if (finding.status === "polishing") {
    addStep("Polishing in cloud", "in_cloud");
  } else if (finding.polish) {
    addStep("Polished in cloud", "in_cloud");
  } else if (finding.status === "draft" && !isOnline()) {
    addStep("Polish waits for a connection");
  }
  if (attached.length > 0) addStep(plural(attached.length, "photo"));
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
  actions.append(areaSelect(finding));
  actions.append(
    actionButton("New area", `area-new:${finding.id}`, () => {
      void addBlankArea().then(async (created) => {
        await moveFinding(finding.id, created.id);
        map.editName(created.id);
      });
    }),
    actionButton("Add photo", `photo-add:${finding.id}`, () => {
      photoTargetId = finding.id;
      photoInput.click();
    }),
    actionButton("Camera", `camera:${finding.id}`, () => void openCamera(finding.id)),
  );
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

  // A model call landing must not close an Area dropdown that is open: the
  // card that holds it is kept as it is until the dropdown is left.
  const active = document.activeElement;
  const held =
    !releaseHeldCard && active instanceof HTMLSelectElement && feed.contains(active)
      ? active.closest<HTMLLIElement>("li.card")
      : null;
  releaseHeldCard = false;

  const newestFirst = [...findings].sort((a, b) => b.seq - a.seq);
  feed.replaceChildren(
    ...newestFirst.map((finding) =>
      held && held.dataset.id === finding.id ? held : renderCard(finding),
    ),
  );

  if (!held && focusKey && !focusKey.startsWith("pin:")) {
    feed
      .querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      ?.focus();
  }

  const total = findings.length;
  const reviewed = findings.filter((finding) => finding.polish).length;
  feedEmpty.hidden = total > 0;
  const countText =
    total === 0 ? "" : `${total} captured, ${reviewed} polished in cloud`;
  if (feedCount.textContent !== countText) feedCount.textContent = countText;

  // The queue is everything the cloud has not polished yet.
  const waiting = total - reviewed;
  const working =
    pendingSteps.size > 0 ||
    findings.some(
      (finding) => finding.status === "structuring" || finding.status === "polishing",
    );
  const failed = findings.filter(
    (finding) => !finding.polish && (finding.captureError ?? finding.polishError),
  ).length;
  let state = "waiting";
  let queue: string;
  if (waiting === 0) {
    state = "done";
    queue = `All ${plural(total, "finding")} polished`;
  } else if (!isOnline()) {
    queue = `${waiting} in queue for cloud`;
  } else if (working) {
    state = "syncing";
    queue = `${waiting} in queue, syncing`;
  } else if (!configured) {
    queue = `${waiting} not polished: cloud not configured`;
  } else {
    queue = `${waiting} not polished${failed > 0 ? `, ${failed} failed` : ""}`;
  }
  queueText.hidden = total === 0;
  queueText.dataset.state = state;
  // A live region: only touch it when the words change.
  if (queueText.textContent !== queue) queueText.textContent = queue;
}

function networkLabel(record: CallRecord): string {
  if (record.simulatedOffline) return "offline (simulated)";
  return record.browserOnline ? "online" : "offline";
}

const STEP_LABELS: Record<CallRecord["step"], string> = {
  structure: "Structure",
  polish: "Polish",
  photo: "Photo assist",
};

function renderDock(): void {
  kpiList.replaceChildren(
    ...computeKpis(findings, calls).map((kpi) => {
      const cell = el("div", "kpi");
      cell.dataset.key = kpi.key;
      cell.append(
        el("dt", undefined, kpi.label),
        el("dd", "kpi-value", kpi.value),
        el("dd", "kpi-detail", kpi.detail),
      );
      return cell;
    }),
  );

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
    cell(STEP_LABELS[record.step]);
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
}

function drawReport(): void {
  if (!visit) return;
  renderReport(paper, {
    visit,
    preset: preset(),
    findings,
    areas,
    photosOf,
    photoUrl,
  });
}

function renderView(): void {
  const view = !visit ? "setup" : location.hash === "#report" ? "report" : "capture";
  document.body.dataset.view = view;
  setupView.hidden = view !== "setup";
  captureView.hidden = view !== "capture";
  reportView.hidden = view !== "report";
  visitBar.hidden = !visit;
  viewTabs.hidden = !visit;
  if (visit) {
    if (document.activeElement !== siteInput) siteInput.value = visit.site;
    visitType.textContent = visit.typeLabel;
  }
  for (const [tab, current] of [
    [tabCapture, view === "capture"],
    [tabReport, view === "report"],
  ] as const) {
    if (current) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (view === "report") drawReport();
}

function renderExamples(): void {
  examples.replaceChildren(
    ...preset().examples.map((note) => {
      const item = el("li");
      const button = el("button", "example", note);
      button.type = "button";
      button.addEventListener("click", () => {
        noteInput.value = note;
        noteInput.focus();
      });
      item.append(button);
      return item;
    }),
  );
}

function render(): void {
  renderMap();
  renderFeed();
  renderDock();
  renderView();
}

// ------------------------------------------------------ delete, undo, clear

/** Drops the photos of a finding whose delete can no longer be undone. */
async function purgePhotos(findingId: string): Promise<void> {
  for (const photo of photosOf(findingId)) forgetPhotoUrl(photo.id);
  photos.delete(findingId);
  await deletePhotosOf(findingId);
}

async function removeFinding(id: string): Promise<void> {
  const finding = findingById(id);
  if (!finding) return;
  const previous = lastDeleted;
  findings = findings.filter((other) => other.id !== id);
  if (selectedId === id) selectedId = null;
  lastDeleted = finding;
  await deleteFinding(id);
  if (previous) await purgePhotos(previous.id);

  const undo = actionButton("Undo", "undo", () => void undoDelete(), "quiet");
  showFeedStatus(`Finding ${finding.seq} deleted. `, undo);
  render();
  undo.focus();
}

async function undoDelete(): Promise<void> {
  const finding = lastDeleted;
  if (!finding) return;
  const startedIn = generation;
  lastDeleted = null;
  // A step that was in flight when the finding was deleted never landed.
  if (finding.status === "structuring") finding.status = "queued";
  if (finding.status === "polishing") finding.status = "draft";
  // Its area may have been removed or merged away in the meantime.
  if (!areaById(finding.areaId)) finding.areaId = null;
  if (finding.areaId === null && finding.extraction) {
    finding.areaId = (await ensureArea(finding.extraction.area, "note")).id;
  }
  if (startedIn !== generation) return;
  await saveFinding(finding);
  if (startedIn !== generation) {
    // The visit was cleared during the write: take the row back out.
    await deleteFinding(finding.id);
    return;
  }
  findings.push(finding);
  findings.sort((a, b) => a.seq - b.seq);
  showFeedStatus(`Finding ${finding.seq} restored.`);
  render();
  sync(false);
}

clearButton.addEventListener("click", () => {
  const photoCount = [...photos.values()].reduce((sum, list) => sum + list.length, 0);
  clearText.textContent = `This deletes ${plural(findings.length, "finding")}, ${plural(photoCount, "photo")}, ${plural(areas.length, "area")} and the routing log from this device. It cannot be undone.`;
  clearDialog.returnValue = "cancel";
  clearDialog.showModal();
});

clearDialog.addEventListener("close", () => {
  if (clearDialog.returnValue !== "confirm") return;
  void (async () => {
    // Reset memory first, so a call that returns during the delete is dropped.
    generation += 1;
    visit = null;
    findings = [];
    areas = [];
    calls = [];
    selectedId = null;
    lastDeleted = null;
    for (const id of [...photoUrls.keys()]) forgetPhotoUrl(id);
    photos.clear();
    await clearVisit();
    showFeedStatus();
    captureStatus.textContent = "";
    showCaptureStatus();
    if (location.hash) history.replaceState(null, "", location.pathname);
    render();
    setupSite.focus();
  })();
});

// --------------------------------------------------------------- visit setup

function selectedPresetId(): string {
  return (
    setupPresets.querySelector<HTMLInputElement>("input:checked")?.value ??
    DEFAULT_PRESET_ID
  );
}

for (const option of PRESETS) {
  const label = el("label", "preset");
  const radio = el("input");
  radio.type = "radio";
  radio.name = "preset";
  radio.value = option.id;
  radio.checked = option.id === DEFAULT_PRESET_ID;
  radio.addEventListener("change", () => {
    setupCustom.hidden = selectedPresetId() !== CUSTOM_PRESET_ID;
  });
  const text = el("span", "preset-text");
  text.append(
    el("b", undefined, option.label),
    el("span", undefined, option.description),
  );
  label.append(radio, text);
  setupPresets.append(label);
}

setupView.addEventListener("submit", (event) => {
  event.preventDefault();
  const chosen = presetById(selectedPresetId());
  const customLabel = setupCustomLabel.value.replace(/\s+/g, " ").trim();
  if (chosen.id === CUSTOM_PRESET_ID && customLabel === "") {
    setupStatus.textContent = "Name the visit type first.";
    setupCustomLabel.focus();
    return;
  }
  setupStatus.textContent = "";
  const next: Visit = {
    site: setupSite.value.replace(/\s+/g, " ").trim(),
    presetId: chosen.id,
    typeLabel: chosen.id === CUSTOM_PRESET_ID ? customLabel : chosen.label,
    startedAt: new Date().toISOString(),
  };
  void saveVisit(next).then(() => {
    visit = next;
    // A leftover #report would open the empty report instead of capture.
    if (location.hash) history.replaceState(null, "", location.pathname);
    setupSite.value = "";
    setupCustomLabel.value = "";
    renderExamples();
    render();
    noteInput.focus();
  });
});

siteInput.addEventListener("change", () => {
  if (!visit) return;
  visit.site = siteInput.value.replace(/\s+/g, " ").trim();
  void saveVisit(visit);
});

// --------------------------------------------------------------------- start

printButton.addEventListener("click", () => window.print());
// Printing from the capture view still prints the report.
window.addEventListener("beforeprint", drawReport);
window.addEventListener("hashchange", renderView);

onStoreBlocked(() => {
  setupStatus.textContent =
    "Plumb is open in another tab with an older version. Close that tab, then reload this one.";
});

async function start(): Promise<void> {
  applyNetwork(true);

  try {
    const [storedVisit, storedAreas, storedFindings, storedPhotos, storedCalls] =
      await Promise.all([
        loadVisit(),
        loadAreas(),
        loadFindings(),
        loadPhotos(),
        loadCalls(),
      ]);
    visit = storedVisit;
    areas = storedAreas;
    findings = storedFindings;
    calls = storedCalls;
    for (const photo of storedPhotos) {
      // A photo whose finding is gone was left by a delete that was never undone.
      if (!storedFindings.some((finding) => finding.id === photo.findingId)) {
        void deletePhoto(photo.id);
        continue;
      }
      photos.set(photo.findingId, [...photosOf(photo.findingId), photo]);
    }
  } catch (cause) {
    setupStatus.textContent = `Saved findings could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`;
  }

  // A step that was in flight when the page closed never landed.
  for (const finding of findings) {
    if (finding.status === "structuring") finding.status = "queued";
    if (finding.status === "polishing") finding.status = "draft";
    cardShownAt.set(finding.id, -CARD_IN_MS);
  }

  renderExamples();
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
