import { formatBytes } from "./photos";
import type { CallRecord, Finding } from "./store";

/** Fields the capture step fills in for one note. */
const FIELDS_PER_NOTE = 5;

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
export function computeKpis(findings: Finding[], calls: CallRecord[]): Kpi[] {
  const offlineNotes = findings.filter(
    (finding) =>
      finding.extraction &&
      finding.extractedOffline &&
      finding.extractionTier === "on_device",
  ).length;

  const cloudWhileOffline = calls.filter(
    (record) => record.tier === "in_cloud" && wasOffline(record),
  );
  const offlineBytes = cloudWhileOffline.reduce(
    (sum, record) => sum + record.promptBytes,
    0,
  );
  const offlineCalls = calls.filter(wasOffline).length;

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
      value: String(offlineNotes * FIELDS_PER_NOTE),
      detail:
        offlineNotes === 0
          ? "No note structured offline yet"
          : `From ${plural(offlineNotes, "note")}, on device`,
    },
    {
      key: "offline-upload",
      label: "Sent to cloud while offline",
      value: formatBytes(offlineBytes),
      detail:
        offlineCalls === 0
          ? "No model calls made offline yet"
          : `Prompt bytes, over ${plural(offlineCalls, "offline call")}`,
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
