import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

const restoreHint = "/jorgex:header builtin";
const frameIntervalMs = 40;
const animationDurationMs = 800;

// Generated from assets/brand/eye-logo.svg (SHA-256 0bd562e7...).
const compactEye = [
  "  ⢀⣀⣤⣴⣶⣾⠿⣿⣏",
  "⠲⢾⣏⡉⢷⣿⣧⡾ ⢀⣽⡷",
  "  ⠈⠙⠛⠿⠿⠷⠿⠛⠉",
];

const wideEye = [
  "                ⣀⣀⣤⣤⣴⣶⣶⣾⣿⣿⣿⣿⡿⠃",
  "         ⢀⣀⣤⣴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡁",
  "    ⢀⣀⣤⣶⣾⣿⣿⣿⠿⣿⣿⣿⣿⠿⠿⣿⣿⡄ ⠈⠙⠻⢿⣿⣿⣄",
  "⣀⣤⣴⣾⣿⣿⡿⠿⠛⠋⢹⣿⣤⣾⣿⣿⣯  ⣸⣿⣷     ⠙⢿⣿⣷⣄",
  "⠈⠛⠿⣿⣿⣶⣤⣀  ⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇    ⣀⣴⣿⣿⡿⠋",
  "    ⠙⠻⢿⣿⣿⣷⣶⣬⣿⣿⣿⣿⣿⣿⡿⠟⠁⣀⣀⣤⣴⣾⣿⣿⡿⠋",
  "        ⠉⠛⠻⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠉",
  "             ⠈⠉⠉⠛⠛⠛⠛⠛⠛⠋⠉",
];

const glyphs: Record<string, string[]> = {
  J: ["█████", "   ██", "   ██", "   ██", "   ██", "██ ██", " ███ "],
  O: [" ███ ", "██ ██", "██ ██", "██ ██", "██ ██", "██ ██", " ███ "],
  R: ["████ ", "██ ██", "██ ██", "████ ", "██ █ ", "██ ██", "██ ██"],
  G: [" ███ ", "██ ██", "██   ", "██ ██", "██ ██", "██ ██", " ███ "],
  E: ["█████", "██   ", "██   ", "████ ", "██   ", "██   ", "█████"],
  X: ["██ ██", "██ ██", " ███ ", "  █  ", " ███ ", "██ ██", "██ ██"],
  P: ["████ ", "██ ██", "██ ██", "████ ", "██   ", "██   ", "██   "],
  I: ["█████", "  █  ", "  █  ", "  █  ", "  █  ", "  █  ", "█████"],
  " ": ["   ", "   ", "   ", "   ", "   ", "   ", "   "],
};

const wideWordmark = renderWordmark("JORGEX PI");

export default function installBranding(pi: ExtensionAPI) {
  const activeHeaders = new Set<{ dispose(): void }>();
  const disposeActiveHeaders = () => {
    for (const header of activeHeaders) header.dispose();
    activeHeaders.clear();
  };

  pi.on("session_start", (_event, ctx) => {
    applyCustomHeader(ctx, activeHeaders);
  });

  pi.on("session_shutdown", () => {
    disposeActiveHeaders();
  });

  pi.registerCommand("jorgex:header", {
    description: "Use `builtin` or `custom` to choose the startup header for this session.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;

      if (args.trim() === "builtin") {
        disposeActiveHeaders();
        ctx.ui.setHeader(undefined);
        return;
      }

      if (args.trim() === "custom") applyCustomHeader(ctx, activeHeaders);
    },
  });
}

function applyCustomHeader(
  ctx: ExtensionContext | ExtensionCommandContext,
  activeHeaders: Set<{ dispose(): void }>,
) {
  if (ctx.mode !== "tui") return;
  const workspace = basename(ctx.cwd || process.cwd()) || ".";
  ctx.ui.setHeader((tui, theme) => {
    const component = createJorgeXHeader(tui, theme, workspace, () => activeHeaders.delete(component));
    activeHeaders.add(component);
    return component;
  });
}

function createJorgeXHeader(
  tui: { requestRender(): void; terminal?: { columns: number } },
  theme: Theme,
  workspace: string,
  onDispose: () => void,
) {
  const animated = shouldAnimate() && (tui.terminal?.columns ?? 40) >= 40;
  const startedAt = Date.now();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const component = {
    render(width: number) {
      const progress = animated && width >= 40 ? Math.min(1, (Date.now() - startedAt) / animationDurationMs) : 1;
      return renderFrame(width, workspace, progress, theme);
    },
    invalidate() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      onDispose();
    },
  };

  if (animated) {
    timer = setInterval(() => {
      if (Date.now() - startedAt >= animationDurationMs) {
        component.dispose();
        tui.requestRender();
        return;
      }
      tui.requestRender();
    }, frameIntervalMs);
    timer.unref?.();
  }

  return component;
}

function renderFrame(width: number, workspace: string, progress: number, theme: Theme): string[] {
  let plain: string[];
  if (width < 40) plain = renderNarrow();
  else if (width < 100) plain = renderCompact(workspace);
  else plain = renderWide(workspace);
  return plain.map((line, index) => {
    const fitted = truncateToWidth(line, Math.max(0, width), "");
    return colorize(reveal(fitted, progress, index, plain.length), theme, index);
  });
}

function renderNarrow(): string[] {
  return [...compactEye, `JorgeX Pi · Pi v${VERSION}`];
}

function renderCompact(workspace: string): string[] {
  return [
    ...compactEye,
    "",
    "JorgeX Pi",
    `PI       v${VERSION}`,
    `PATH     ${workspace}`,
    restoreHint,
  ];
}

function renderWide(workspace: string): string[] {
  const artRows = wideEye.map((eyeLine, index) => {
    const title = index < wideWordmark.length ? wideWordmark[index] : "JorgeX Pi";
    return `${eyeLine.padEnd(35)}   ${title}`.trimEnd();
  });
  return [
    ...artRows,
    "",
    `PI v${VERSION}`,
    `PATH ${workspace}  ·  ${restoreHint}`,
  ];
}

function renderWordmark(value: string): string[] {
  return Array.from({ length: 7 }, (_, row) =>
    [...value].map((character) => glyphs[character]?.[row] ?? glyphs[" "][row]).join(" ").trimEnd(),
  );
}

function reveal(line: string, progress: number, row: number, rowCount: number): string {
  if (progress >= 1 || line.length === 0) return line;
  const rowDelay = row / Math.max(rowCount * 4, 1);
  const local = Math.max(0, Math.min(1, (progress - rowDelay) / (1 - rowDelay)));
  return truncateToWidth(line, Math.ceil(visibleWidth(line) * local), "");
}

function colorize(line: string, theme: Theme, row: number): string {
  if (process.env.NO_COLOR) return line;
  if (/[⠀-⣿█]/u.test(line) || line.includes("JorgeX Pi")) return theme.fg("text", line);
  if (line.includes("PATH")) return theme.fg("muted", line);
  return theme.fg(row % 3 === 2 ? "customMessageLabel" : "borderAccent", line);
}

function shouldAnimate(): boolean {
  if (process.stdout.isTTY !== true || process.env.JORGEX_PI_MOTION === "reduce") return false;
  return process.env.JORGEX_PI_MOTION === "full" || (!process.env.CI && process.env.TERM !== "dumb");
}
