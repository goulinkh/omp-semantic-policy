import type { JSXElement } from "satori/jsx";
import {
  canvas,
  connector,
  contextItem,
  diagramHeader,
  diagramNote,
  element,
  icon,
  mono,
  stageCard,
} from "./components.js";
import {
  diagramPalette,
  palettes,
  type DiagramPalette,
  type Palette,
  type Theme,
} from "./design.js";

export const ONBOARDING_HEIGHT = 400;
export const EVALUATION_HEIGHT = 586;
export const COMPILATION_HEIGHT = 620;

type SyntaxToken = readonly [text: string, color?: string];
type SyntaxRow = readonly SyntaxToken[];

function decisionRow(
  label: string,
  detail: string,
  palette: DiagramPalette,
  highlighted = false,
): JSXElement {
  return element(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "9px 14px",
        marginBottom: 10,
        border: `1px solid ${highlighted ? palette.highlight.border : palette.border}`,
        borderRadius: 7,
        background: highlighted ? palette.highlight.background : palette.raised,
      },
    },
    element(
      "div",
      {
        style: {
          display: "flex",
          color: highlighted ? palette.highlight.text : palette.text,
          fontSize: 18,
          fontWeight: 700,
        },
      },
      label,
    ),
    element(
      "div",
      {
        style: {
          display: "flex",
          color: highlighted ? palette.highlight.text : palette.muted,
          fontSize: 16,
          lineHeight: 1.35,
        },
      },
      detail,
    ),
  );
}

function outcomeRow(label: string, detail: string, palette: DiagramPalette): JSXElement {
  return element(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } },
    element(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "center",
          width: 76,
          padding: "5px 0",
          borderRadius: 6,
          fontFamily: "Ubuntu Mono",
          fontSize: 14,
          fontWeight: 700,
          color: palette.text,
          background: palette.raised,
          border: `1px solid ${palette.border}`,
        },
      },
      label,
    ),
    element("div", { style: { display: "flex", fontSize: 16 } }, detail),
  );
}

function coverageItem(label: string, detail: string, palette: Palette): JSXElement {
  return element(
    "div",
    { style: { display: "flex", flexDirection: "column", flex: 1, gap: 7 } },
    mono(label, palette, { size: 12, bold: true }),
    element(
      "div",
      { style: { display: "flex", color: palette.text, fontSize: 16, lineHeight: 1.4 } },
      detail,
    ),
  );
}

export function onboardingDiagram(theme: Theme): JSXElement {
  const palette = diagramPalette(theme);

  return canvas(
    palette,
    diagramHeader("01", "Project onboarding", palette),
    element(
      "div",
      { style: { display: "flex", alignItems: "center" } },
      stageCard(
        "01",
        "Resolve project",
        "project",
        416,
        220,
        palette,
        contextItem("Boundary", "Nearest Git worktree", palette),
        contextItem("Isolation", "Nested repositories stay separate", palette),
      ),
      connector(palette, 34),
      stageCard(
        "02",
        "Load instructions",
        "sources",
        418,
        220,
        palette,
        contextItem("Sources", "Profile · AGENTS.md · CLAUDE.md", palette),
        contextItem("Scope", "Project-wide + subtree rules", palette),
      ),
      connector(palette, 34),
      stageCard(
        "03",
        "Compile snapshot",
        "snapshot",
        416,
        220,
        palette,
        contextItem("Active snapshot", "Compiled rules + provenance", palette),
        contextItem("Identity", "Immutable · versioned", palette),
      ),
    ),
    diagramNote(
      "Source changes",
      "Current snapshot gates the edit. Refresh before the next high-impact action.",
      palette,
    ),
  );
}

export function evaluationDiagram(theme: Theme): JSXElement {
  const palette = diagramPalette(theme);

  return canvas(
    palette,
    diagramHeader("02", "Action evaluation", palette),
    element(
      "div",
      { style: { display: "flex", alignItems: "center" } },
      stageCard(
        "01",
        "Capture + scope",
        "action",
        350,
        320,
        palette,
        contextItem("Before effect", "Enabled tools · shell · Python · workflow", palette),
        contextItem("Context", "Snapshot + user authorization", palette),
        contextItem("Local scope check", "Operation · targets · scoped rules", palette),
      ),
      connector(palette, 34),
      stageCard(
        "02",
        "Evaluate policy",
        "decision",
        550,
        320,
        palette,
        decisionRow("No applicable rules", "Allow locally · no model call", palette, true),
        decisionRow("Applicable rules", "TypeSafe AI · consent + redaction", palette),
        decisionRow("Evaluator unavailable", "Local fallback", palette, true),
      ),
      connector(palette, 34),
      stageCard(
        "03",
        "Enforce + audit",
        "audit",
        350,
        320,
        palette,
        outcomeRow("ALLOW", "Run", palette),
        outcomeRow("DENY", "Block", palette),
        outcomeRow("PROMPT", "Confirm", palette),
        outcomeRow("REVISE", "Replace input", palette),
        element(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: "auto",
              paddingTop: 14,
              borderTop: `1px solid ${palette.border}`,
            },
          },
          mono("Redacted audit", palette, { size: 12, bold: true }),
        ),
      ),
    ),
    diagramNote("Default deny", "Uncertainty blocks. Interactive confirmation is opt-in.", palette),
    element(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 32,
          marginTop: 32,
        },
      },
      element(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 9, width: 350 } },
        icon("boundary", palette.blue, 20),
        element(
          "div",
          { style: { display: "flex", fontSize: 17, fontWeight: 700 } },
          "Policy gate, not a sandbox",
        ),
      ),
      coverageItem("Dispatch only", "Broad execution · restricted subagents", palette),
      coverageItem("Outside", "Nested effects · excluded tools · trusted extensions", palette),
    ),
  );
}

function codeBlock(lines: readonly SyntaxRow[], caption: string, palette: Palette): JSXElement {
  return element(
    "div",
    { style: { display: "flex", flexDirection: "column", flex: 1 } },
    element(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          fontFamily: "Ubuntu Mono",
          fontSize: 17,
        },
      },
      lines.map((tokens, index) =>
        element(
          "div",
          { style: { display: "flex", height: 24, alignItems: "center" } },
          element(
            "span",
            { style: { color: palette.muted, width: 28, marginRight: 16, textAlign: "right" } },
            String(index + 1),
          ),
          element(
            "div",
            { style: { display: "flex", whiteSpace: "pre" } },
            tokens.map(([text, color]) =>
              element("span", { style: { color: color ?? palette.text, whiteSpace: "pre" } }, text),
            ),
          ),
        ),
      ),
    ),
    element(
      "div",
      {
        style: {
          display: "flex",
          marginTop: "auto",
          paddingTop: 16,
          borderTop: `1px solid ${palette.border}`,
          color: palette.muted,
          fontSize: 15,
        },
      },
      caption,
    ),
  );
}

export function compilationDiagram(theme: Theme): JSXElement {
  const palette = diagramPalette(theme);
  const string = theme === "light" ? "#067343" : "#8bd9a8";
  const keyword = theme === "light" ? "#7136b8" : "#c4a5ff";
  const standard: readonly SyntaxRow[] = [
    [["# Logging", palette.blue]],
    [],
    [["- ", palette.muted], ["Never log access tokens."]],
    [],
    [["```ts", palette.muted]],
    [["// Log metadata, not credentials.", palette.muted]],
    [["logger"], [".info", palette.blue], ["({"]],
    [["  userId", palette.blue], [": user.id,"]],
    [["  event", palette.blue], [": "], ['"signed_in"', string], [","]],
    [["});"]],
    [["```", palette.muted]],
  ];
  const policy: readonly SyntaxRow[] = [
    [["{"]],
    [['  "snapshotId"', palette.blue], [": "], ['"demo-snapshot"', string], [","]],
    [
      ['  "sources"', palette.blue],
      [": [["],
      ['"demo-source"', string],
      [", "],
      ["100", keyword],
      ["]],"],
    ],
    [['  "contexts"', palette.blue], [": [["], ['"Logging"', string], ["]],"]],
    [['  "rules"', palette.blue], [": ["]],
    [["    ["]],
    [
      ['      "r0"', string],
      [", "],
      ['"hard"', string],
      [", "],
      ["0", keyword],
      [", "],
      ["0", keyword],
      [","],
    ],
    [['      "Never log access tokens."', string]],
    [["    ]"]],
    [["  ]"]],
    [["}"]],
  ];

  return canvas(
    palette,
    diagramHeader("03", "From standard to rule", palette),
    element(
      "div",
      { style: { display: "flex", alignItems: "center" } },
      stageCard(
        "MD",
        element("span", { style: { fontFamily: "Ubuntu Mono" } }, "AGENTS.md"),
        "sources",
        632,
        440,
        palette,
        codeBlock(standard, "Code fences excluded.", palette),
      ),
      connector(palette, 54),
      stageCard(
        "JSON",
        element("span", { style: { fontFamily: "Ubuntu Mono" } }, "TypeSafe"),
        "snapshot",
        632,
        440,
        palette,
        codeBlock(policy, "Compiled policy excerpt.", palette),
      ),
    ),
    diagramNote("Example", "Action + user authorization accompany the policy.", palette),
  );
}

export function mark(theme: Theme): JSXElement {
  const palette = palettes[theme];
  if (palette === undefined) {
    throw new Error(`Unknown theme: ${theme}`);
  }

  return element(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "transparent",
      },
    },
    icon("mark", palette.blue, 52),
  );
}
