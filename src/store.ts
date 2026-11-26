import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Extraction, Polish } from "./ai/schema";
import type { PlanRoom } from "./plan";

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

export interface Pin {
  /** Position in floor plan units. */
  x: number;
  y: number;
  /** Room under the pin. Set by where the inspector clicked, not by a model. */
  room: PlanRoom;
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
  /** Why the note could not be structured yet, if it could not. */
  captureError: string | null;
  pin: Pin | null;
  polish: Polish | null;
  polishError: string | null;
}

/** One measured model call, kept for the routing log. */
export interface CallRecord {
  id?: number;
  at: string;
  findingSeq: number;
  step: "structure" | "polish";
  /** Firebase AI Logic inference mode the call was made with. */
  mode: string;
  tier: Tier | null;
  ms: number;
  /** What the browser reported when the call started. */
  browserOnline: boolean;
  /** True if the "Simulate offline" demo control was on. */
  simulatedOffline: boolean;
  error: string | null;
}

interface PlumbDB extends DBSchema {
  findings: { key: string; value: Finding };
  calls: { key: number; value: CallRecord };
  meta: { key: string; value: string };
}

let dbPromise: Promise<IDBPDatabase<PlumbDB>> | null = null;

function db(): Promise<IDBPDatabase<PlumbDB>> {
  dbPromise ??= openDB<PlumbDB>("plumb", 1, {
    upgrade(database) {
      database.createObjectStore("findings", { keyPath: "id" });
      database.createObjectStore("calls", {
        keyPath: "id",
        autoIncrement: true,
      });
      database.createObjectStore("meta");
    },
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

export async function deleteFinding(id: string): Promise<void> {
  await (await db()).delete("findings", id);
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

/** Removes every finding and call. The site name is kept. */
export async function clearInspection(): Promise<void> {
  const database = await db();
  const tx = database.transaction(["findings", "calls"], "readwrite");
  await Promise.all([
    tx.objectStore("findings").clear(),
    tx.objectStore("calls").clear(),
    tx.done,
  ]);
}
