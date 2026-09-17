import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori, { type Font } from "satori";
import { themes, type Theme } from "./design.js";
import {
  COMPILATION_HEIGHT,
  EVALUATION_HEIGHT,
  ONBOARDING_HEIGHT,
  compilationDiagram,
  evaluationDiagram,
  mark,
  onboardingDiagram,
} from "./diagrams.js";
import { renderGlassDiagram } from "./glass.js";

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const fontRoot = join(process.cwd(), "node_modules/@fontsource");

const [sansRegular, sansMedium, sansBold, monoRegular, monoBold] = await Promise.all([
  readFile(join(fontRoot, "ubuntu-sans/files/ubuntu-sans-latin-400-normal.woff")),
  readFile(join(fontRoot, "ubuntu-sans/files/ubuntu-sans-latin-500-normal.woff")),
  readFile(join(fontRoot, "ubuntu-sans/files/ubuntu-sans-latin-700-normal.woff")),
  readFile(join(fontRoot, "ubuntu-mono/files/ubuntu-mono-latin-400-normal.woff")),
  readFile(join(fontRoot, "ubuntu-mono/files/ubuntu-mono-latin-700-normal.woff")),
]);

const fonts: Font[] = [
  { name: "Ubuntu Sans", data: sansRegular, weight: 400, style: "normal" },
  { name: "Ubuntu Sans", data: sansMedium, weight: 500, style: "normal" },
  { name: "Ubuntu Sans", data: sansBold, weight: 700, style: "normal" },
  { name: "Ubuntu Mono", data: monoRegular, weight: 400, style: "normal" },
  { name: "Ubuntu Mono", data: monoBold, weight: 700, style: "normal" },
];

export async function renderOnboarding(theme: Theme): Promise<string> {
  return renderGlassDiagram(onboardingDiagram(theme), theme, ONBOARDING_HEIGHT, fonts);
}

export async function renderEvaluation(theme: Theme): Promise<string> {
  return renderGlassDiagram(evaluationDiagram(theme), theme, EVALUATION_HEIGHT, fonts);
}

export async function renderCompilation(theme: Theme): Promise<string> {
  return renderGlassDiagram(compilationDiagram(theme), theme, COMPILATION_HEIGHT, fonts);
}

export async function renderMark(theme: Theme): Promise<string> {
  return satori(mark(theme), { width: 64, height: 64, fonts });
}

await Promise.all(
  themes.flatMap((theme) => [
    renderOnboarding(theme).then((svg) =>
      writeFile(join(outputDirectory, `policy-onboarding-${theme}.svg`), svg, "utf8"),
    ),
    renderEvaluation(theme).then((svg) =>
      writeFile(join(outputDirectory, `policy-evaluation-${theme}.svg`), svg, "utf8"),
    ),
    renderCompilation(theme).then((svg) =>
      writeFile(join(outputDirectory, `policy-compilation-${theme}.svg`), svg, "utf8"),
    ),
    renderMark(theme).then((svg) =>
      writeFile(join(outputDirectory, `policy-mark-${theme}.svg`), svg, "utf8"),
    ),
  ]),
);
