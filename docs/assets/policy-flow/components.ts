import type { CSSProperties, JSXElement, JSXNode } from "satori/jsx";
import type { DiagramPalette, Palette } from "./design.js";

type ElementProperties = Readonly<Record<string, unknown>> & { readonly style?: CSSProperties };

export function element(
  type: string,
  properties: ElementProperties,
  ...children: JSXNode[]
): JSXElement {
  return {
    type,
    key: null,
    props: {
      ...properties,
      children: children.flat(),
    },
  };
}

const iconPaths = {
  mark: [
    "M12 2 21 5.5v6.2c0 6.2-3.7 10.7-9 14.3-5.3-3.6-9-8.1-9-14.3V5.5L12 2Z",
    "M12 7v12M7.5 12h9",
  ],
  project: ["M3 7h7l2 2h9v11H3V7Z", "M3 11h18"],
  sources: ["M7 3h10l4 4v14H7V3Z", "M17 3v5h4", "M10 12h8M10 16h8"],
  snapshot: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  action: ["M4 5h16v14H4V5Z", "m8 9 3 3-3 3", "M13 15h3"],
  context: ["M12 3a9 9 0 1 0 9 9", "M12 7v5l3 2", "M8 12h8"],
  decision: ["M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z", "m9 12 2 2 4-4"],
  audit: ["M5 3h14v18H5V3Z", "M8 8h8M8 12h8M8 16h5"],
  boundary: ["M12 3 21 8v4c0 5.8-3.7 9.8-9 13-5.3-3.2-9-7.2-9-13V8l9-5Z"],
} as const;

export type IconName = keyof typeof iconPaths;

export function icon(kind: IconName, color: string, size = 20): JSXElement {
  const common = {
    fill: "none",
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  return element(
    "svg",
    { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    iconPaths[kind].map((path) => element("path", { d: path, ...common })),
  );
}

interface MonoOptions {
  readonly color?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly spacing?: number;
  readonly uppercase?: boolean;
}

export function mono(text: string, palette: Palette, options: MonoOptions = {}): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        color: options.color ?? palette.muted,
        fontFamily: "Ubuntu Mono",
        fontSize: options.size ?? 10,
        fontWeight: options.bold ? 700 : 400,
        letterSpacing: options.spacing ?? 0.7,
        textTransform: options.uppercase === false ? "none" : "uppercase",
      },
    },
    text,
  );
}

function sectionHeader(title: string, palette: Palette): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        height: 24,
        color: palette.text,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.7,
        textTransform: "uppercase",
      },
    },
    title,
  );
}

export function diagramNote(label: string, detail: string, palette: Palette): JSXElement {
  return element(
    "div",
    {
      "data-glass-radius": 12,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 18,
        marginTop: 32,
        padding: "14px 20px",
        border: "1px solid transparent",
        borderRadius: 12,
      },
    },
    mono(label, palette, { size: 13, bold: true, color: palette.text }),
    element("div", { style: { display: "flex", color: palette.muted, fontSize: 16 } }, detail),
  );
}

export function connector(palette: DiagramPalette, width = 52): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width,
        height: 24,
      },
    },
    element(
      "svg",
      { width, height: 24, viewBox: `0 0 ${width} 24`, "aria-hidden": "true" },
      element("path", {
        d: `M1 12H${width - 2}M${width - 8} 6l6 6-6 6`,
        fill: "none",
        stroke: palette.line,
        strokeWidth: 1.25,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ),
  );
}

export function stageCard(
  number: string,
  title: JSXNode,
  iconName: IconName,
  width: number,
  height: number,
  palette: Palette,
  ...children: JSXNode[]
): JSXElement {
  return element(
    "div",
    {
      "data-glass-radius": 18,
      style: {
        display: "flex",
        flexDirection: "column",
        width,
        height,
        padding: 22,
        border: "1px solid transparent",
        borderRadius: 18,
      },
    },
    element(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20 } },
      icon(iconName, palette.blue, 24),
      element("div", { style: { display: "flex", fontSize: 22, fontWeight: 700 } }, title),
      element(
        "div",
        { style: { display: "flex", marginLeft: "auto" } },
        mono(number, palette, { color: palette.blue, size: 14, bold: true }),
      ),
    ),
    element(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "center",
          gap: 14,
        },
      },
      ...children,
    ),
  );
}

export function contextItem(label: string, detail: string, palette: Palette): JSXElement {
  return element(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 6 } },
    mono(label, palette, { size: 12, bold: true }),
    element("div", { style: { display: "flex", fontSize: 17, lineHeight: 1.4 } }, detail),
  );
}

export function canvas(palette: Palette, ...children: JSXNode[]): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "24px 40px 20px",
        color: palette.text,
        border: `1px solid ${palette.border}`,
        borderRadius: 12,
        fontFamily: "Ubuntu Sans",
      },
    },
    ...children,
  );
}

export function diagramHeader(title: string, palette: Palette): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 18,
      },
    },
    sectionHeader(title, palette),
    element(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 9 } },
      icon("mark", palette.blue, 20),
      mono("OMP Semantic Policy", palette, { color: palette.text, bold: true, size: 10 }),
    ),
  );
}
