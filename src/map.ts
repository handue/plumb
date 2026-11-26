import type { Severity } from "./ai/schema";
import type { Area, AreaOrigin } from "./store";

export interface MapPin {
  id: string;
  seq: number;
  label: string;
  /** Drives the pin color. */
  state: "draft" | "low" | "moderate" | "high";
}

export interface MapTile {
  area: Area;
  pins: MapPin[];
  /** Worst reviewed severity in the area, if any finding was reviewed. */
  heat: Severity | null;
}

export interface MapHandlers {
  onRename(areaId: string, name: string): void;
  onRemove(areaId: string): void;
  onSelectPin(findingId: string): void;
  /** A pin was dropped on another area. */
  onMove(findingId: string, areaId: string): void;
}

export interface MapView {
  update(tiles: MapTile[], selectedId: string | null): void;
  /** Puts the caret in an area's name, with the name selected. */
  editName(areaId: string): void;
}

const ORIGIN_BADGES: Record<AreaOrigin, string> = {
  note: "Created from note",
  preset: "Suggested area",
  manual: "",
};

const DRAG_TYPE = "application/x-plumb-finding";
/** Length of the pin drop animation in app.css. */
const PIN_DROP_MS = 420;

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

interface TileParts {
  root: HTMLElement;
  name: HTMLInputElement;
  badge: HTMLSpanElement;
  remove: HTMLButtonElement;
  pins: HTMLUListElement;
  empty: HTMLParagraphElement;
}

/**
 * Draws the site as a grid of area tiles. Tiles are updated in place rather
 * than rebuilt, so an area name being edited survives a model call landing.
 * The layout is schematic: tile order is creation order, not geography.
 */
export function createMap(host: HTMLElement, handlers: MapHandlers): MapView {
  const tiles = new Map<string, TileParts>();
  /** When each pin was first drawn, so a rebuilt pin continues its drop. */
  const drawnPins = new Map<string, number>();
  let firstUpdate = true;

  function buildTile(area: Area): TileParts {
    const root = el("section", "tile");
    root.dataset.id = area.id;

    const head = el("header", "tile-head");
    const name = el("input", "tile-name");
    name.type = "text";
    name.maxLength = 40;
    name.spellcheck = false;
    name.autocomplete = "off";
    name.addEventListener("change", () => handlers.onRename(area.id, name.value));
    // After a rename the stored name may differ from what was typed.
    name.addEventListener("blur", () => {
      queueMicrotask(() => {
        name.value = name.dataset.saved ?? name.value;
      });
    });
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") name.blur();
      if (event.key === "Escape") {
        name.value = name.dataset.saved ?? "";
        name.blur();
        // Escape here cancels the edit only.
        event.stopPropagation();
      }
    });

    const badge = el("span", "tile-badge");
    const remove = el("button", "tile-remove quiet", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => handlers.onRemove(area.id));
    head.append(name, badge, remove);

    const pins = el("ul", "tile-pins");
    const empty = el("p", "tile-empty", "No findings here yet.");
    root.append(head, pins, empty);

    root.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      root.classList.add("is-drop-target");
    });
    root.addEventListener("dragleave", (event) => {
      if (!root.contains(event.relatedTarget as Node | null)) {
        root.classList.remove("is-drop-target");
      }
    });
    root.addEventListener("drop", (event) => {
      root.classList.remove("is-drop-target");
      const findingId = event.dataTransfer?.getData(DRAG_TYPE);
      if (!findingId) return;
      event.preventDefault();
      handlers.onMove(findingId, area.id);
    });

    return { root, name, badge, remove, pins, empty };
  }

  function buildPin(pin: MapPin, selected: boolean, age: number): HTMLLIElement {
    const item = el("li");
    const button = el("button", "pin");
    button.type = "button";
    button.draggable = true;
    button.dataset.id = pin.id;
    button.dataset.state = pin.state;
    button.dataset.focusKey = `pin:${pin.id}`;
    if (selected) button.classList.add("is-selected");
    if (age < PIN_DROP_MS) {
      button.classList.add("is-new");
      button.style.animationDelay = `-${Math.round(age)}ms`;
    }
    button.setAttribute("aria-label", `Finding ${pin.seq}: ${pin.label}`);
    button.setAttribute("aria-pressed", String(selected));
    button.append(
      el("span", "pin-dot", String(pin.seq)),
      el("span", "pin-tag", pin.label),
    );
    button.addEventListener("click", () => handlers.onSelectPin(pin.id));
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(DRAG_TYPE, pin.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    item.append(button);
    return item;
  }

  return {
    update(next, selectedId) {
      const now = performance.now();
      // Drop stale tiles first, so the rest are not re-inserted around them.
      const nextIds = new Set(next.map((tile) => tile.area.id));
      for (const [id, parts] of tiles) {
        if (nextIds.has(id)) continue;
        parts.root.remove();
        tiles.delete(id);
      }
      const focusKey = (document.activeElement as HTMLElement | null)?.dataset
        ?.focusKey;

      next.forEach(({ area, pins, heat }, index) => {
        let parts = tiles.get(area.id);
        if (!parts) {
          const built = buildTile(area);
          parts = built;
          tiles.set(area.id, built);
          if (!firstUpdate) {
            built.root.classList.add("is-new");
            built.root.addEventListener(
              "animationend",
              () => built.root.classList.remove("is-new"),
              { once: true },
            );
          }
        }
        // Keep DOM order in step with the given order.
        if (host.children[index] !== parts.root) {
          host.insertBefore(parts.root, host.children[index] ?? null);
        }

        parts.name.dataset.saved = area.name;
        if (document.activeElement !== parts.name) parts.name.value = area.name;

        parts.root.setAttribute("aria-label", `Area ${area.name}`);
        parts.name.setAttribute("aria-label", `Name of area ${area.name}`);
        parts.pins.setAttribute("aria-label", `Findings in ${area.name}`);
        parts.badge.textContent = ORIGIN_BADGES[area.origin];
        parts.badge.hidden = ORIGIN_BADGES[area.origin] === "";
        parts.remove.hidden = pins.length > 0;
        parts.remove.setAttribute("aria-label", `Remove area ${area.name}`);
        parts.empty.hidden = pins.length > 0;

        if (heat) parts.root.dataset.heat = heat.toLowerCase();
        else delete parts.root.dataset.heat;

        parts.pins.replaceChildren(
          ...pins.map((pin) => {
            if (!drawnPins.has(pin.id)) {
              // Pins present at load are old; they do not drop.
              drawnPins.set(pin.id, firstUpdate ? -PIN_DROP_MS : now);
            }
            return buildPin(
              pin,
              pin.id === selectedId,
              now - (drawnPins.get(pin.id) ?? now),
            );
          }),
        );
      });

      if (focusKey?.startsWith("pin:")) {
        host
          .querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
          ?.focus({ preventScroll: true });
      }
      firstUpdate = false;
    },

    editName(areaId) {
      const parts = tiles.get(areaId);
      if (!parts) return;
      parts.root.scrollIntoView({ block: "nearest" });
      parts.name.focus();
      parts.name.select();
    },
  };
}
