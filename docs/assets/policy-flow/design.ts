export const WIDTH = 1400;

export type Theme = "light" | "dark";
export const themes: readonly Theme[] = ["light", "dark"];

export interface Palette {
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly inverse: string;
  readonly blue: string;
}

export interface DiagramPalette extends Palette {
  readonly line: string;
  readonly raised: string;
  readonly highlight: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
}

export const palettes: Readonly<Record<Theme, Palette>> = {
  light: {
    background: "#f8faff",
    text: "#111111",
    muted: "#666666",
    border: "#e5e5e5",
    accent: "#111111",
    inverse: "#ffffff",
    blue: "#0070f3",
  },
  dark: {
    background: "#080809",
    text: "#ededed",
    muted: "#a1a1aa",
    border: "#2e2e2e",
    accent: "#ededed",
    inverse: "#000000",
    blue: "#52a8ff",
  },
};

export function diagramPalette(theme: Theme): DiagramPalette {
  const palette = palettes[theme];
  if (palette === undefined) {
    throw new Error(`Unknown theme: ${theme}`);
  }
  return {
    ...palette,
    blue: theme === "light" ? "#005cc8" : palette.blue,
    line: palette.muted,
    raised: theme === "light" ? "rgba(255, 255, 255, 0.64)" : "rgba(0, 0, 0, 0.3)",
    highlight: {
      background: theme === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(17, 24, 39, 0.07)",
      border: theme === "dark" ? "rgba(255, 255, 255, 0.22)" : "rgba(17, 24, 39, 0.12)",
      text: palette.text,
    },
  };
}
