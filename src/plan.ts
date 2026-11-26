import type { Room, Severity } from "./ai/schema";

/** Rooms drawn on the demo floor plan. 100 plan units are one meter. */
export const PLAN_ROOMS = [
  "living",
  "kitchen",
  "bath",
  "hall",
  "bedroom",
  "study",
] as const;

export type PlanRoom = (typeof PLAN_ROOMS)[number];

export const ROOM_LABELS: Record<Room, string> = {
  living: "Living room",
  kitchen: "Kitchen",
  bath: "Bathroom",
  hall: "Hall",
  bedroom: "Bedroom",
  study: "Study",
  other: "Other",
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROOM_RECTS: Record<PlanRoom, Rect> = {
  living: { x: 0, y: 0, w: 340, h: 280 },
  kitchen: { x: 340, y: 0, w: 260, h: 280 },
  bath: { x: 600, y: 0, w: 200, h: 280 },
  hall: { x: 0, y: 280, w: 800, h: 80 },
  bedroom: { x: 0, y: 360, w: 400, h: 280 },
  study: { x: 400, y: 360, w: 400, h: 280 },
};

const PLAN_W = 800;
const PLAN_H = 640;

/** Outer walls, with a gap for the entry door on the hall's left side. */
const OUTER_WALL = "M0 295V0H800V640H0V345";
/** Partition walls, with gaps where the doors are. */
const INNER_WALLS = [
  "M340 0V110", // living | kitchen, open plan below
  "M600 0V280", // kitchen | bath
  "M0 280H150M200 280H440M490 280H680M730 280H800", // top rooms | hall
  "M0 360H300M350 360H450M500 360H800", // hall | bottom rooms
  "M400 360V640", // bedroom | study
].join("");
/** Door leaves and their swing arcs. */
const DOORS = [
  "M0 295H50A50 50 0 0 1 0 345", // entry
  "M150 280V230A50 50 0 0 1 200 280", // living
  "M440 280V230A50 50 0 0 1 490 280", // kitchen
  "M680 280V230A50 50 0 0 1 730 280", // bath
  "M300 360V410A50 50 0 0 0 350 360", // bedroom
  "M450 360V410A50 50 0 0 0 500 360", // study
].join("");
/** Windows, drawn over the outer wall. */
const WINDOWS = "M70 0H250M410 0H530M120 640H300M520 640H700M800 430V570";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, String(value));
  }
  if (text !== undefined) element.textContent = text;
  return element;
}

export function roomAt(x: number, y: number): PlanRoom | null {
  for (const room of PLAN_ROOMS) {
    const r = ROOM_RECTS[room];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return room;
  }
  return null;
}

/** The plan room a model-extracted room maps to, if it is on the plan. */
export function toPlanRoom(room: Room | undefined): PlanRoom | null {
  return room && room !== "other" ? room : null;
}

export interface PlanPin {
  id: string;
  seq: number;
  x: number;
  y: number;
  label: string;
  /** Drives the pin color. */
  state: "draft" | "low" | "moderate" | "high";
}

export interface PlanHandlers {
  /** A point on the plan was chosen while placing. */
  onPlace(x: number, y: number, room: PlanRoom): void;
  onSelectPin(id: string): void;
}

export interface PlanView {
  setPins(pins: PlanPin[], selectedId: string | null): void;
  setHeat(heat: Partial<Record<PlanRoom, Severity>>): void;
  /** Turns placing mode on or off, and highlights a suggested room. */
  setPlacing(active: boolean, suggested: PlanRoom | null): void;
  /** Moves keyboard focus to a room while placing. Defaults to the first room. */
  focusRoom(room: PlanRoom | null): void;
  focusPin(id: string): void;
}

function dimensionString(
  horizontal: boolean,
  stops: number[],
): SVGGElement {
  const group = svg("g", { class: "dimension" });
  const offset = -24;
  const first = stops[0];
  const last = stops[stops.length - 1];
  group.append(
    svg(
      "path",
      horizontal
        ? { d: `M${first} ${offset}H${last}` }
        : { d: `M${offset} ${first}V${last}` },
    ),
  );
  for (const stop of stops) {
    group.append(
      svg(
        "path",
        horizontal
          ? { d: `M${stop - 5} ${offset + 5}L${stop + 5} ${offset - 5}` }
          : { d: `M${offset - 5} ${stop + 5}L${offset + 5} ${stop - 5}` },
      ),
    );
  }
  for (let i = 1; i < stops.length; i++) {
    const middle = (stops[i - 1] + stops[i]) / 2;
    const meters = `${((stops[i] - stops[i - 1]) / 100).toFixed(1)} m`;
    const label = horizontal
      ? svg("text", { x: middle, y: offset - 8 }, meters)
      : svg(
          "text",
          {
            x: offset - 8,
            y: middle,
            transform: `rotate(-90 ${offset - 8} ${middle})`,
          },
          meters,
        );
    group.append(label);
  }
  return group;
}

/**
 * Draws the floor plan into an <svg>. With handlers the plan is interactive:
 * pins can be selected and, in placing mode, a point or room can be chosen.
 * Without handlers it is a static drawing for the report.
 */
export function createPlan(
  host: SVGSVGElement,
  handlers?: PlanHandlers,
): PlanView {
  host.setAttribute("viewBox", `-56 -56 ${PLAN_W + 84} ${PLAN_H + 84}`);
  host.replaceChildren();

  const roomLayer = svg("g");
  const rooms = new Map<PlanRoom, SVGRectElement>();
  for (const room of PLAN_ROOMS) {
    const r = ROOM_RECTS[room];
    const rect = svg("rect", {
      class: "room",
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      "data-room": room,
    });
    rooms.set(room, rect);
    roomLayer.append(rect);
  }

  const drawing = svg("g", { class: "drawing", "aria-hidden": "true" });
  drawing.append(
    dimensionString(true, [0, 340, 600, 800]),
    dimensionString(false, [0, 280, 360, 640]),
    svg("path", { class: "door", d: DOORS }),
    svg("path", { class: "wall", d: INNER_WALLS }),
    svg("path", { class: "wall wall-outer", d: OUTER_WALL }),
    svg("path", { class: "window-gap", d: WINDOWS }),
    svg("path", { class: "window", d: WINDOWS }),
  );
  for (const room of PLAN_ROOMS) {
    const r = ROOM_RECTS[room];
    drawing.append(
      svg(
        "text",
        // The hall label sits clear of the entry door's swing.
        { class: "room-label", x: r.x + (room === "hall" ? 72 : 18), y: r.y + 30 },
        ROOM_LABELS[room],
      ),
    );
  }

  const pinLayer = svg("g");
  host.append(roomLayer, drawing, pinLayer);

  let placing = false;
  let currentPins: PlanPin[] = [];
  /** Pins drawn before, so only a newly placed pin plays the drop. */
  let drawn: Set<string> | null = null;

  /** A spot in the room that does not sit on top of an existing pin. */
  function freeSpot(room: PlanRoom): { x: number; y: number } {
    const r = ROOM_RECTS[room];
    const taken = currentPins.filter((pin) => roomAt(pin.x, pin.y) === room);
    const columns = Math.max(1, Math.floor((r.w - 80) / 70));
    const index = taken.length;
    return {
      x: r.x + 50 + (index % columns) * 70,
      y: Math.min(
        r.y + r.h - 24,
        r.y + r.h / 2 + 10 + Math.floor(index / columns) * 44,
      ),
    };
  }

  if (handlers) {
    host.addEventListener("click", (event) => {
      const target = event.target as Element;
      const pin = target.closest<SVGGElement>(".pin");
      if (pin && !placing) {
        handlers.onSelectPin(pin.dataset.id ?? "");
        return;
      }
      if (!placing) return;
      const matrix = host.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse(),
      );
      const room = roomAt(point.x, point.y);
      if (room) handlers.onPlace(Math.round(point.x), Math.round(point.y), room);
    });

    host.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target as Element;
      const pin = target.closest<SVGGElement>(".pin");
      if (pin && !placing) {
        event.preventDefault();
        handlers.onSelectPin(pin.dataset.id ?? "");
        return;
      }
      const room = (target as SVGElement).dataset?.room as PlanRoom | undefined;
      if (placing && room) {
        event.preventDefault();
        const spot = freeSpot(room);
        handlers.onPlace(spot.x, spot.y, room);
      }
    });
  }

  return {
    setPins(pins, selectedId) {
      currentPins = pins;
      const groups = pins.map((pin) => {
        const group = svg("g", {
          class: "pin",
          "data-id": pin.id,
          "data-state": pin.state,
          transform: `translate(${pin.x} ${pin.y})`,
        });
        if (pin.id === selectedId) group.classList.add("is-selected");
        if (drawn && !drawn.has(pin.id)) group.classList.add("is-new");
        if (handlers) {
          group.setAttribute("tabindex", "0");
          group.setAttribute("role", "button");
          group.setAttribute(
            "aria-label",
            `Finding ${pin.seq}: ${pin.label}`,
          );
        }
        const flip = pin.x > PLAN_W - 190;
        group.append(
          svg("circle", { class: "pin-halo", r: 19 }),
          svg("circle", { class: "pin-dot", r: 12.5 }),
          svg("text", { class: "pin-number", y: 5 }, String(pin.seq)),
          svg(
            "text",
            {
              class: "pin-tag",
              x: flip ? -20 : 20,
              y: 5,
              "text-anchor": flip ? "end" : "start",
            },
            pin.label,
          ),
        );
        return group;
      });
      drawn = new Set(pins.map((pin) => pin.id));
      // Pins are redrawn on every update, so hand focus to the new node.
      const active = document.activeElement;
      const focusedId =
        active instanceof SVGElement && pinLayer.contains(active)
          ? active.closest<SVGGElement>(".pin")?.dataset.id
          : undefined;
      pinLayer.replaceChildren(...groups);
      if (focusedId) {
        groups
          .find((group) => group.dataset.id === focusedId)
          ?.focus({ preventScroll: true });
      }
    },

    setHeat(heat) {
      for (const [room, rect] of rooms) {
        const severity = heat[room];
        if (severity) rect.dataset.heat = severity.toLowerCase();
        else delete rect.dataset.heat;
      }
    },

    focusRoom(room) {
      (rooms.get(room ?? PLAN_ROOMS[0]) ?? null)?.focus({ preventScroll: true });
    },

    focusPin(id) {
      pinLayer
        .querySelector<SVGGElement>(`.pin[data-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
    },

    setPlacing(active, suggested) {
      placing = active;
      host.classList.toggle("is-placing", active);
      for (const [room, rect] of rooms) {
        rect.classList.toggle("is-suggested", active && room === suggested);
        if (active) {
          rect.setAttribute("tabindex", "0");
          rect.setAttribute("role", "button");
          rect.setAttribute("aria-label", `Place pin in ${ROOM_LABELS[room]}`);
        } else {
          rect.removeAttribute("tabindex");
          rect.removeAttribute("role");
          rect.removeAttribute("aria-label");
        }
      }
    },
  };
}
