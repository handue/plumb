import type { CallRecord, Tier } from "./store";

const STEP_NAMES: Record<CallRecord["step"], string> = {
  warmup: "Warm-up",
  structure: "Structure",
  polish: "Polish",
  photo: "Photo assist",
};

/** Calls kept on each lane. Older ones are in the routing log. */
const LANE_LIMIT = 24;

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

function latency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The lane a call is drawn on: the tier that answered. A failed call has no
 * answer, so it goes where it was sent. Null when that is not known.
 */
function laneOf(record: CallRecord): Tier | null {
  if (record.tier) return record.tier;
  if (record.mode === "ONLY_IN_CLOUD") return "in_cloud";
  if (record.mode === "ONLY_ON_DEVICE") return "on_device";
  // "Prefer on device" goes to the device only when its model is ready.
  if (record.deviceState === undefined) return null;
  return record.deviceState === "available" ? "on_device" : "in_cloud";
}

export interface RailView {
  /** `busy` says which lanes have a call in flight right now. */
  update(calls: CallRecord[], busy: Record<Tier, boolean>): void;
}

/**
 * Two lanes, one per tier. Every measured model call lands on the lane of the
 * tier that answered it, with its latency, so the routing can be read at a
 * glance instead of from the log table. It draws the same records as the log.
 */
export function createRail(host: HTMLElement): RailView {
  const lanes = {} as Record<Tier, { root: HTMLElement; track: HTMLOListElement }>;
  for (const [tier, label] of [
    ["on_device", "On device"],
    ["in_cloud", "Cloud"],
  ] as const) {
    const root = el("div", "rail-lane");
    root.dataset.tier = tier;
    const track = el("ol", "rail-track");
    track.setAttribute("aria-label", `${label} calls`);
    root.append(el("span", "rail-label", label), track);
    host.append(root);
    lanes[tier] = { root, track };
  }

  const drawn = new Map<number, HTMLLIElement>();
  let first = true;

  return {
    update(calls, busy) {
      const wanted = new Set<number>();
      for (const record of calls) {
        if (record.id === undefined) continue;
        wanted.add(record.id);
        if (drawn.has(record.id)) continue;
        const lane = laneOf(record);
        // Still in the routing log; just not placed on a lane.
        if (lane === null) continue;

        const item = el("li", "rail-call");
        item.dataset.step = record.step;
        if (record.tier === null) item.dataset.failed = "true";
        const who = record.findingSeq > 0 ? `#${record.findingSeq}` : STEP_NAMES[record.step];
        item.append(el("b", undefined, who));
        if (record.findingSeq > 0) {
          item.append(el("span", "visually-hidden", `${STEP_NAMES[record.step]}, `));
        }
        item.append(
          el("span", undefined, record.tier === null ? "failed" : latency(record.ms)),
        );
        item.title = `${STEP_NAMES[record.step]}, ${record.mode}, ${record.tier === null ? "failed" : `answered ${record.tier === "on_device" ? "on device" : "in cloud"}`} after ${record.ms.toLocaleString("en-US")} ms`;
        if (!first) {
          item.classList.add("is-new");
          item.addEventListener(
            "animationend",
            () => item.classList.remove("is-new"),
            { once: true },
          );
        }
        const { track } = lanes[lane];
        track.append(item);
        while (track.childElementCount > LANE_LIMIT) track.firstElementChild?.remove();
        drawn.set(record.id, item);
      }
      // A cleared visit takes its calls off the rail.
      for (const [id, item] of drawn) {
        if (wanted.has(id)) continue;
        item.remove();
        drawn.delete(id);
      }
      for (const tier of ["on_device", "in_cloud"] as const) {
        lanes[tier].root.classList.toggle("is-busy", busy[tier]);
        lanes[tier].track.setAttribute("aria-busy", String(busy[tier]));
      }
      first = false;
    },
  };
}
