import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Extraction, Polish } from "./ai/schema";

/** Tier that answered a model call, as reported by the SDK. */
export type Tier = "on_device" | "in_cloud";

/**
 * Where a finding is in the capture loop:
 *
 * - queued: the note is saved but not structured yet.
 * - structuring: a model call is extracting fields from the note.
 * - draft: fields are extracted; severity is still unknown.
 * - polishing: the cloud model is writing the report sentence.
 * - polished: sentence, severity and flags are in.
 */
export type FindingStatus =
  | "queued"
  | "structuring"
  | "draft"
  | "polishing"
  | "polished";

/** How an area came to exist. */
export type AreaOrigin = "note" | "manual" | "preset";

/**
 * A place on the site, shown as a tile. Areas are schematic: they have a name
 * and an order, not a position or a size on a real floor plan.
 */
export interface Area {
  id: string;
  name: string;
  origin: AreaOrigin;
  createdAt: string;
}

export interface Finding {
  id: string;
  /** Number shown on the pin and the card. */
  seq: number;
  note: string;
  createdAt: string;
  status: FindingStatus;
  extraction: Extraction | null;
  extractionTier: Tier | null;
  /** True if the fields were extracted while the app was offline. */
  extractedOffline: boolean;
  /**
   * True if that offline state came from the "Simulate offline" demo control
   * while the browser itself still had a connection.
   */
  extractedSimulated?: boolean;
  /** Why the note could not be structured yet, if it could not. */
  captureError: string | null;
  /** The tile the pin sits in. Null until the note is structured or filed. */
  areaId: string | null;
  /** True once the inspector has filed the finding by hand. */
  areaSetByUser: boolean;
  polish: Polish | null;
  polishError: string | null;
  /** True if the note began as a draft the on-device model wrote from a photo. */
  noteFromPhoto?: boolean;
}

/** A photo the inspector attached to a finding. Stored on this device. */
export interface Photo {
  id: string;
  findingId: string;
  /** Downscaled JPEG. */
  blob: Blob;
  width: number;
  height: number;
  createdAt: string;
  /** True if this photo was given to the on-device model to draft a note. */
  readByModel?: boolean;
}

/** One measured model call, kept for the routing log. */
export interface CallRecord {
  id?: number;
  at: string;
  findingSeq: number;
  step: "structure" | "polish" | "photo" | "warmup";
  /** Firebase AI Logic inference mode the call was made with. */
  mode: string;
  tier: Tier | null;
  ms: number;
  /** UTF-8 size of the prompt text handed to the SDK. */
  promptBytes: number;
  /** What the browser reported when the call started. */
  browserOnline: boolean;
  /** State of the on-device model when the call was made, if it was read. */
  deviceState?: string;
  /** True if the "Simulate offline" demo control was on. */
  simulatedOffline: boolean;
  error: string | null;
}

/** The visit in progress. */
export interface Visit {
  site: string;
  presetId: string;
  /** Visit type as shown, which for a custom visit is what the user typed. */
  typeLabel: string;
  startedAt: string;
}

interface PlumbDB extends DBSchema {
  findings: { key: string; value: Finding };
  areas: { key: string; value: Area };
  photos: {
    key: string;
    value: Photo;
    indexes: { findingId: string };
  };
  calls: { key: number; value: CallRecord };
  meta: { key: string; value: string };
}

let dbPromise: Promise<IDBPDatabase<PlumbDB>> | null = null;
let blockedHandler: (() => void) | null = null;

/** Called if another tab holds an older version of the database open. */
export function onStoreBlocked(handler: () => void): void {
  blockedHandler = handler;
}

function db(): Promise<IDBPDatabase<PlumbDB>> {
  dbPromise ??= openDB<PlumbDB>("plumb", 2, {
    upgrade(database, oldVersion) {
      // Version 1 stored pins on a fixed floor plan. Nothing from it carries
      // over to areas, so its stores are rebuilt.
      if (oldVersion < 2) {
        for (const name of [...database.objectStoreNames]) {
          database.deleteObjectStore(name);
        }
        database.createObjectStore("findings", { keyPath: "id" });
        database.createObjectStore("areas", { keyPath: "id" });
        database
          .createObjectStore("photos", { keyPath: "id" })
          .createIndex("findingId", "findingId");
        database.createObjectStore("calls", {
          keyPath: "id",
          autoIncrement: true,
        });
        database.createObjectStore("meta");
      }
    },
    blocked() {
      blockedHandler?.();
    },
    blocking(_current, _blocked, event) {
      // A newer tab wants to upgrade: let go, so it is not left waiting.
      (event.target as IDBDatabase).close();
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
  }).catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  return dbPromise;
}

export async function loadFindings(): Promise<Finding[]> {
  const all = await (await db()).getAll("findings");
  return all.sort((a, b) => a.seq - b.seq);
}

export async function saveFinding(finding: Finding): Promise<void> {
  await (await db()).put("findings", finding);
}

/** Deletes a finding. Its photos are kept until `deletePhotosOf` is called. */
export async function deleteFinding(id: string): Promise<void> {
  await (await db()).delete("findings", id);
}

export async function loadAreas(): Promise<Area[]> {
  const all = await (await db()).getAll("areas");
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveArea(area: Area): Promise<void> {
  await (await db()).put("areas", area);
}

export async function deleteArea(id: string): Promise<void> {
  await (await db()).delete("areas", id);
}

export async function loadPhotos(): Promise<Photo[]> {
  const all = await (await db()).getAll("photos");
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Throws a `QuotaExceededError` DOMException when the device is full. */
export async function savePhoto(photo: Photo): Promise<void> {
  const database = await db();
  const tx = database.transaction("photos", "readwrite");
  // The quota error surfaces on the transaction, not on the put request.
  await Promise.all([tx.store.put(photo), tx.done]);
}

export async function deletePhoto(id: string): Promise<void> {
  await (await db()).delete("photos", id);
}

export async function deletePhotosOf(findingId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction("photos", "readwrite");
  const keys = await tx.store.index("findingId").getAllKeys(findingId);
  await Promise.all([...keys.map((key) => tx.store.delete(key)), tx.done]);
}

export async function loadCalls(): Promise<CallRecord[]> {
  return (await db()).getAll("calls");
}

export async function addCall(record: CallRecord): Promise<CallRecord> {
  const id = await (await db()).add("calls", record);
  return { ...record, id };
}

export async function getMeta(key: string): Promise<string | undefined> {
  return (await db()).get("meta", key);
}

export async function setMeta(key: string, value: string): Promise<void> {
  await (await db()).put("meta", value, key);
}

const VISIT_KEY = "visit";

export async function loadVisit(): Promise<Visit | null> {
  const raw = await getMeta(VISIT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Visit;
  } catch {
    return null;
  }
}

export async function saveVisit(visit: Visit): Promise<void> {
  await setMeta(VISIT_KEY, JSON.stringify(visit));
}

/** Removes the visit and everything captured in it. */
export async function clearVisit(): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    ["findings", "areas", "photos", "calls", "meta"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("findings").clear(),
    tx.objectStore("areas").clear(),
    tx.objectStore("photos").clear(),
    tx.objectStore("calls").clear(),
    tx.objectStore("meta").delete(VISIT_KEY),
    tx.done,
  ]);
}
