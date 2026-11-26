import { SEVERITIES, type Severity } from "./ai/schema";
import { createPlan, ROOM_LABELS, type PlanPin } from "./plan";
import type { Finding } from "./store";

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

/** Room shown for a finding: the pinned room wins over the extracted one. */
export function roomLabel(finding: Finding): string {
  if (finding.pin) return ROOM_LABELS[finding.pin.room];
  if (finding.extraction) return ROOM_LABELS[finding.extraction.room];
  return "Not structured";
}

/** High first, then Moderate, Low, and findings with no severity yet. */
function reportOrder(a: Finding, b: Finding): number {
  const rank = (finding: Finding): number =>
    finding.polish ? SEVERITIES.indexOf(finding.polish.severity) : -1;
  return rank(b) - rank(a) || a.seq - b.seq;
}

/**
 * Builds the printable report from what is stored. It only states what the
 * data shows: findings without a cloud review are listed as such.
 */
export function renderReport(
  paper: HTMLElement,
  findings: Finding[],
  site: string,
  pins: PlanPin[],
): void {
  const polished = findings.filter((finding) => finding.polish);
  const waiting = findings.length - polished.length;
  const count = (severity: Severity): number =>
    polished.filter((finding) => finding.polish?.severity === severity).length;

  const header = el("header", "paper-head");
  const titles = el("div");
  titles.append(
    el("h1", undefined, "Inspection report"),
    el("p", "paper-site", site || "Unnamed site"),
  );
  const complete = findings.length > 0 && waiting === 0;
  const stamp = el(
    "p",
    complete ? "stamp stamp-ready" : "stamp stamp-draft",
    complete ? "Ready" : "Draft",
  );
  header.append(titles, stamp);

  const meta = el(
    "p",
    "paper-meta",
    `${new Date().toLocaleDateString("en-US", { dateStyle: "long" })}. ${plural(findings.length, "finding")}.`,
  );

  paper.replaceChildren(header, meta);

  if (findings.length === 0) {
    paper.append(
      el(
        "p",
        "paper-empty",
        "There is nothing to report yet. Capture a finding first.",
      ),
    );
    return;
  }

  const summary = el("dl", "paper-summary");
  const addSummary = (label: string, value: number, key: string): void => {
    const cell = el("div");
    cell.dataset.key = key;
    cell.append(el("dt", undefined, label), el("dd", undefined, String(value)));
    summary.append(cell);
  };
  addSummary("High", count("High"), "high");
  addSummary("Moderate", count("Moderate"), "moderate");
  addSummary("Low", count("Low"), "low");
  if (waiting > 0) addSummary("Not reviewed yet", waiting, "draft");
  paper.append(summary);

  const figure = el("figure", "paper-plan");
  const drawing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  drawing.setAttribute("class", "plan plan-print");
  drawing.setAttribute("role", "img");
  drawing.setAttribute(
    "aria-label",
    "Floor plan with numbered pins for each finding",
  );
  createPlan(drawing).setPins(pins, null);
  figure.append(drawing);
  const unpinned = findings.filter((finding) => !finding.pin).length;
  figure.append(
    el(
      "figcaption",
      undefined,
      unpinned > 0
        ? `Numbers match the findings below. ${plural(unpinned, "finding")} without a pin ${unpinned === 1 ? "is" : "are"} not on the plan.`
        : "Numbers match the findings below.",
    ),
  );
  paper.append(figure);

  const list = el("ol", "paper-findings");
  for (const finding of [...findings].sort(reportOrder)) {
    const item = el("li");
    const severity = finding.polish?.severity;
    const chip = el(
      "span",
      "chip",
      severity ?? "Not reviewed",
    );
    chip.dataset.key = severity ? severity.toLowerCase() : "draft";

    const body = el("div", "paper-finding");
    const lead = el("p");
    lead.append(el("b", undefined, `${finding.seq}. ${roomLabel(finding)}. `));
    if (finding.polish) {
      lead.append(finding.polish.sentence);
    } else if (finding.extraction) {
      const { item: what, issue, size_cm } = finding.extraction;
      const text = `${what}: ${issue}${size_cm === null ? "" : `, about ${size_cm} cm`}.`;
      lead.append(text.charAt(0).toUpperCase() + text.slice(1));
    } else {
      lead.append("Note not structured yet.");
    }
    body.append(lead);

    const flags: string[] = [];
    if (finding.polish?.safety_flag) flags.push("Safety concern");
    if (finding.polish?.water_flag) flags.push("Water related");
    if (flags.length > 0) body.append(el("p", "paper-flags", flags.join(", ")));

    body.append(el("p", "paper-note", `Inspector's note: "${finding.note}"`));
    item.append(chip, body);
    list.append(item);
  }
  paper.append(list);

  const onDevice = findings.filter(
    (finding) => finding.extractionTier === "on_device",
  ).length;
  const structured = findings.filter((finding) => finding.extraction).length;
  const provenance = [
    `${onDevice} of ${plural(structured, "structured note")} ${onDevice === 1 ? "was" : "were"} turned into fields on the inspector's device, with no connection needed.`,
    polished.length > 0
      ? "Report wording and severity were written by Gemini in the cloud. Both steps ran through Firebase AI Logic."
      : "Report wording and severity are added by Gemini in the cloud once there is a connection.",
    "Severity is a model's suggestion. An inspector should review this report before it is sent.",
  ];
  paper.append(el("p", "paper-foot", provenance.join(" ")));
}
