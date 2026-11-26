import { GENERAL_AREA, type Extraction } from "./ai/schema";
import { formatBytes } from "./photos";
import type { CallRecord, Finding } from "./store";

/**
 * Fields the model filled in from one note. A size it left null and an area
 * it could not name are not counted; the water flag is always a decision.
 */
function filledFields(extraction: Extraction): number {
  const area = extraction.area.trim().toLowerCase();
  return (
    (area !== "" && area !== GENERAL_AREA.toLowerCase() ? 1 : 0) +
    (extraction.item.trim() ? 1 : 0) +
    (extraction.issue.trim() ? 1 : 0) +
    (extraction.size_cm !== null ? 1 : 0) +
    1
  );
}

export interface Kpi {
  key: "offline-fields" | "offline-upload" | "cloud-calls" | "device-latency";
  label: string;
  value: string;
  detail: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** True if the app was offline, for real or by the demo control, at call start. */
function wasOffline(record: CallRecord): boolean {
  return record.simulatedOffline || !record.browserOnline;
}

/**
 * Figures for the bottom dock. Every value is counted from the findings and
 * the routing log stored on this device. Nothing here is estimated.
 */
export function computeKpis(findings: Finding[], log: CallRecord[]): Kpi[] {
  // The warm-up call loads the model into memory. It is in the routing log,
  // but it is not work on a note, so the figures leave it out.
  const calls = log.filter((record) => record.step !== "warmup");
  const offlineFindings = findings.filter(
    (finding) =>
      finding.extraction &&
      finding.extractedOffline &&
      finding.extractionTier === "on_device",
  );
  const offlineNotes = offlineFindings.length;
  const offlineFields = offlineFindings.reduce(
    (sum, finding) => sum + filledFields(finding.extraction!),
    0,
  );
  const simulatedNotes = offlineFindings.filter(
    (finding) => finding.extractedSimulated,
  ).length;

  const cloudWhileOffline = calls.filter(
    (record) => record.tier === "in_cloud" && wasOffline(record),
  );
  const offlineBytes = cloudWhileOffline.reduce(
    (sum, record) => sum + record.promptBytes,
    0,
  );
  const offlineCalls = calls.filter(wasOffline).length;
  const simulatedCalls = calls.filter(
    (record) => record.simulatedOffline && record.browserOnline,
  ).length;
  const simulatedNote = (count: number): string =>
    count === 0 ? "" : ` (${count} with offline simulated)`;

  const cloudPolish = calls.filter(
    (record) => record.tier === "in_cloud" && record.step === "polish",
  ).length;
  const cloudOther = calls.filter(
    (record) => record.tier === "in_cloud" && record.step !== "polish",
  ).length;

  const deviceTimes = calls
    .filter((record) => record.tier === "on_device")
    .map((record) => record.ms);
  const deviceMedian = median(deviceTimes);

  return [
    {
      key: "offline-fields",
      label: "Fields extracted offline",
      value: String(offlineFields),
      detail:
        offlineNotes === 0
          ? "No note structured offline yet"
          : `From ${plural(offlineNotes, "note")}, on device${simulatedNote(simulatedNotes)}`,
    },
    {
      key: "offline-upload",
      label: "Sent to cloud while offline",
      value: formatBytes(offlineBytes),
      detail:
        offlineCalls === 0
          ? "No model calls made offline yet"
          : `Prompt bytes, over ${plural(offlineCalls, "offline call")}${simulatedNote(simulatedCalls)}`,
    },
    {
      key: "cloud-calls",
      label: "Cloud polish calls",
      value: String(cloudPolish),
      detail:
        cloudOther === 0
          ? "Answered by the cloud model"
          : `Plus ${plural(cloudOther, "capture call")} answered in cloud`,
    },
    {
      key: "device-latency",
      label: "On-device latency",
      value:
        deviceMedian === null
          ? "No calls yet"
          : `${deviceMedian.toLocaleString("en-US")} ms`,
      detail:
        deviceMedian === null
          ? "Measured in this browser"
          : `Median of ${plural(deviceTimes.length, "call")}, measured here`,
    },
  ];
}
