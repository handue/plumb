import { SEVERITIES, type Severity } from "./ai/schema";
import type { Preset } from "./presets";
import type { Area, Finding, Photo, Visit } from "./store";

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

/** High first, then Moderate, Low, and findings with no severity yet. */
function reportOrder(a: Finding, b: Finding): number {
  const rank = (finding: Finding): number =>
    finding.polish ? SEVERITIES.indexOf(finding.polish.severity) : -1;
  return rank(b) - rank(a) || a.seq - b.seq;
}

export interface ReportData {
  visit: Visit;
  preset: Preset;
  findings: Finding[];
  areas: Area[];
  photosOf(findingId: string): Photo[];
  photoUrl(photo: Photo): string;
}

/**
 * Builds the printable report from what is stored. It only states what the
 * data shows: findings without a cloud review are listed as such.
 */
export function renderReport(paper: HTMLElement, data: ReportData): void {
  const { visit, preset, findings, areas } = data;
  const areaName = (finding: Finding): string =>
    areas.find((area) => area.id === finding.areaId)?.name ?? "Not filed";

  const polished = findings.filter((finding) => finding.polish);
  const waiting = findings.length - polished.length;
  const count = (severity: Severity): number =>
    polished.filter((finding) => finding.polish?.severity === severity).length;

  const header = el("header", "paper-head");
  const titles = el("div");
  titles.append(
    el("h1", undefined, preset.reportTitle),
    el("p", "paper-site", visit.site || "Unnamed site"),
  );
  const complete = findings.length > 0 && waiting === 0;
  const stamp = el(
    "p",
    complete ? "stamp stamp-ready" : "stamp stamp-draft",
    // Complete means every finding has a severity, not that it was signed off.
    complete ? "Ready for review" : "Draft",
  );
  header.append(titles, stamp);

  const photoCount = findings.reduce(
    (sum, finding) => sum + data.photosOf(finding.id).length,
    0,
  );
  const readPhotos = findings.reduce(
    (sum, finding) =>
      sum + data.photosOf(finding.id).filter((photo) => photo.readByModel).length,
    0,
  );
  const meta = el(
    "p",
    "paper-meta",
    [
      visit.typeLabel,
      ...(Number.isNaN(Date.parse(visit.startedAt))
        ? []
        : [
            `visit started ${new Date(visit.startedAt).toLocaleDateString("en-US", { dateStyle: "long" })}`,
          ]),
      plural(findings.length, "finding"),
      ...(photoCount > 0 ? [plural(photoCount, "photo")] : []),
    ].join(", ") + ".",
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

  // Summary: one sentence, then the count per area.
  const parts = [
    `${count("High")} high`,
    `${count("Moderate")} moderate`,
    `${count("Low")} low`,
  ];
  const summary = el("div", "paper-summary");
  const sentence = el("p");
  sentence.append(el("b", undefined, "Summary: "));
  sentence.append(
    polished.length === 0
      ? "No finding has been reviewed yet."
      : `${parts.join(", ")}.`,
  );
  if (waiting > 0) {
    sentence.append(
      ` ${plural(waiting, "finding")} ${waiting === 1 ? "has" : "have"} no severity yet and ${waiting === 1 ? "is" : "are"} marked as not reviewed.`,
    );
  }
  summary.append(sentence);

  const areaList = el("ul", "paper-areas");
  for (const area of areas) {
    const inArea = findings.filter((finding) => finding.areaId === area.id);
    if (inArea.length === 0) continue;
    const worst = inArea.reduce<Severity | null>((known, finding) => {
      const severity = finding.polish?.severity;
      if (!severity) return known;
      return !known || SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(known)
        ? severity
        : known;
    }, null);
    const item = el("li");
    item.dataset.key = worst ? worst.toLowerCase() : "draft";
    // Severity in words as well as in the dot's color.
    const level = worst
      ? inArea.length === 1
        ? worst.toLowerCase()
        : `worst: ${worst.toLowerCase()}`
      : "not reviewed";
    item.append(
      el("b", undefined, area.name),
      el("span", undefined, `${plural(inArea.length, "finding")} (${level})`),
    );
    areaList.append(item);
  }
  if (areaList.childElementCount > 0) summary.append(areaList);
  paper.append(summary);

  paper.append(el("h2", "paper-heading", preset.findingsHeading));

  const list = el("ol", "paper-findings");
  for (const finding of [...findings].sort(reportOrder)) {
    const item = el("li");
    const severity = finding.polish?.severity;
    const chip = el("span", "chip", severity ?? "Not reviewed");
    chip.dataset.key = severity ? severity.toLowerCase() : "draft";

    const body = el("div", "paper-finding");
    const lead = el("p");
    lead.append(el("b", undefined, `${areaName(finding)}. `));
    if (finding.polish) {
      lead.append(finding.polish.sentence);
    } else if (finding.extraction) {
      const { item: what, issue, size_cm } = finding.extraction;
      const text = `${what}: ${issue}${size_cm === null ? "" : `, about ${Math.round(size_cm * 10) / 10} cm`}.`;
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

    const photos = data.photosOf(finding.id);
    if (photos.length > 0) {
      const strip = el("div", "paper-photos");
      photos.forEach((photo, index) => {
        const image = el("img");
        image.src = data.photoUrl(photo);
        image.width = photo.width;
        image.height = photo.height;
        image.alt = `Photo ${index + 1} of finding ${finding.seq}, attached by the inspector`;
        strip.append(image);
      });
      body.append(strip);
    }

    // The list is sorted by severity, so the capture number sits to the side.
    const key = el("div", "paper-key");
    key.append(chip, el("span", "paper-ref", `Finding ${finding.seq}`));
    item.append(key, body);
    list.append(item);
  }
  paper.append(list);

  const structured = findings.filter((finding) => finding.extraction).length;
  const onDevice = findings.filter(
    (finding) => finding.extractionTier === "on_device",
  ).length;
  const offline = findings.filter(
    (finding) => finding.extractedOffline && finding.extractionTier === "on_device",
  );
  const simulated = offline.filter((finding) => finding.extractedSimulated).length;
  const real = offline.length - simulated;
  const how = [
    ...(real > 0 ? [`${real} of them with no connection`] : []),
    ...(simulated > 0
      ? [`${simulated} with the connection switched off by the demo control (simulated offline)`]
      : []),
  ];
  const provenance = [
    `${onDevice} of ${plural(structured, "structured note")} ${onDevice === 1 ? "was" : "were"} turned into fields on the inspector's device${how.length > 0 ? `, ${how.join(" and ")}` : ""}.`,
    polished.length === 0
      ? "Report wording and severity are added by Gemini in the cloud once there is a connection."
      : waiting === 0
        ? "Report wording and severity were written by Gemini in the cloud. Both steps ran through Firebase AI Logic."
        : `Report wording and severity for ${polished.length} of ${plural(findings.length, "finding")} were written by Gemini in the cloud; the rest show the captured fields and are marked Not reviewed. Both steps ran through Firebase AI Logic.`,
    ...(photoCount > 0
      ? [
          readPhotos > 0
            ? `Photos were attached by the inspector. ${plural(readPhotos, "photo")} ${readPhotos === 1 ? "was" : "were"} given to the on-device model to draft a note; no photo was sent to the cloud.`
            : "Photos were attached by the inspector and were not analyzed by a model.",
        ]
      : []),
    "Severity is a model's suggestion. An inspector should review this report before it is sent.",
  ];
  paper.append(
    el("h2", "paper-heading paper-heading-small", "How this report was produced"),
    el("p", "paper-foot", provenance.join(" ")),
  );
  const sign = el("p", "paper-sign");
  sign.append(el("span", undefined, "Reviewed by"), el("span", undefined, "Date"));
  paper.append(sign);
}
