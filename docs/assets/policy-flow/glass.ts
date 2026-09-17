import { crc32, deflateSync } from "node:zlib";
import satori, { type Font } from "satori";
import type { JSXNode } from "satori/jsx";
import { WIDTH, palettes, type Theme } from "./design.js";

const PROFILE_SAMPLES = 128;
const glassMapCache = new Map<string, GlassMaps>();

interface GlassCard {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

interface GlassMaps {
  readonly displacement: string;
  readonly specular: string;
  readonly scale: number;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function pngDataUri(width: number, height: number, channels: 3 | 4, pixels: Buffer): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6; // RGB displacement or RGBA specular.
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

// A convex squircle flattens smoothly into the clear interior. Precompute one
// Snell-law cross-section and reuse it around the bezel, including the corners.
// Reference: https://kube.io/blog/liquid-glass-css-svg/
function glassMaps(width: number, height: number, radius: number): GlassMaps {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const bezel = Math.min(radius, w / 2, h / 2);
  const key = `${w}:${h}:${radius}`;
  const cached = glassMapCache.get(key);
  if (cached !== undefined) return cached;

  const displacements: number[] = [];
  let maximum = 0;
  for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
    const remaining = 1 - sample / (PROFILE_SAMPLES - 1);
    const profile = (1 - remaining ** 4) ** 0.25;
    const incident = sample === 0 ? Math.PI / 2 : Math.atan(remaining ** 3 / profile ** 3);
    const refracted = Math.asin(Math.sin(incident) / 1.5);
    const offset = bezel * (2.2 + profile) * Math.tan(incident - refracted);
    displacements.push(offset);
    maximum = Math.max(maximum, offset);
  }
  // SVG samples scale * (channel - 0.5), so full-range encoding needs 2× the peak.
  const scale = maximum * 2;
  const stride = w * 3 + 1;
  const specularStride = w * 4 + 1;
  const pixels = Buffer.alloc(stride * h, 128);
  const specular = Buffer.alloc(specularStride * h);
  for (let y = 0; y < h; y += 1) {
    pixels[y * stride] = 0; // PNG scanline: no predictor.
    for (let x = 0; x < w; x += 1) {
      const dx = x + 0.5 - w / 2;
      const dy = y + 0.5 - h / 2;
      const qx = Math.abs(dx) - (w / 2 - radius);
      const qy = Math.abs(dy) - (h / 2 - radius);
      if (Math.max(qx, qy) <= radius - bezel) continue;
      const cornerX = Math.max(qx, 0);
      const cornerY = Math.max(qy, 0);
      const cornerLength = Math.hypot(cornerX, cornerY);
      const distance = cornerLength + Math.min(Math.max(qx, qy), 0) - radius;
      if (distance >= 0 || distance <= -bezel) continue;

      const nx = (Math.sign(dx) * cornerX) / cornerLength;
      const ny = (Math.sign(dy) * cornerY) / cornerLength;
      const sample = Math.round((-distance / bezel) * (PROFILE_SAMPLES - 1));
      const offset = displacements[sample];
      if (offset === undefined) throw new RangeError("Glass profile sample outside bezel");
      const index = y * stride + 1 + x * 3;
      pixels[index] = Math.round(255 * (0.5 - (nx * offset) / scale));
      pixels[index + 1] = Math.round(255 * (0.5 - (ny * offset) / scale));

      // A top-left light and weaker opposing reflection follow the same normals.
      const alignment = -(nx + ny) * Math.SQRT1_2;
      const highlight = Math.abs(alignment) ** 4 * (alignment > 0 ? 1 : 0.45);
      const intensity = Math.exp(distance / 1.35) * (0.12 + 0.88 * highlight);
      const specularIndex = y * specularStride + 1 + x * 4;
      specular[specularIndex] = 255;
      specular[specularIndex + 1] = 255;
      specular[specularIndex + 2] = 255;
      specular[specularIndex + 3] = Math.round(255 * intensity);
    }
  }
  const maps = {
    displacement: pngDataUri(w, h, 3, pixels),
    specular: pngDataUri(w, h, 4, specular),
    scale,
  };
  glassMapCache.set(key, maps);
  return maps;
}

function glassLayers(theme: Theme, height: number, cards: readonly GlassCard[]): string {
  const dark = theme === "dark";
  const ambient = `<g id="policy-ambient">
    <rect width="${WIDTH}" height="${height}" fill="${palettes[theme].background}"/>
    <ellipse cx="260" cy="${height * 0.35}" rx="640" ry="${height * 0.85}" fill="url(#policy-blue-glow)"/>
    <ellipse cx="1190" cy="${height * 0.8}" rx="560" ry="${height * 0.9}" fill="url(#policy-violet-glow)"/>
    <path d="M-100 ${height * 0.85} C360 ${height * 0.1} 740 ${height * 1.2} 1500 ${height * 0.15}"
      fill="none" stroke="${dark ? "#c5cad4" : "#759bea"}" stroke-opacity="${dark ? 0.22 : 0.16}"
      stroke-width="140" filter="url(#policy-curve-soften)"/>
    <rect width="${WIDTH}" height="${height}" fill="url(#policy-dots)" opacity="${dark ? 0.17 : 0.15}"/>
  </g>`;
  const definitions = `<defs>
    <clipPath id="policy-canvas"><rect width="${WIDTH}" height="${height}" rx="12"/></clipPath>
    <filter id="policy-curve-soften" x="-15%" y="-60%" width="130%" height="220%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    <radialGradient id="policy-blue-glow">
      <stop stop-color="#60a5fa" stop-opacity="${dark ? 0.035 : 0.18}"/>
      <stop offset="1" stop-color="#60a5fa" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="policy-violet-glow">
      <stop stop-color="#a78bfa" stop-opacity="${dark ? 0.025 : 0.14}"/>
      <stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>
    </radialGradient>
    <pattern id="policy-dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="12" cy="12" r="0.7" fill="${dark ? "#c2d4f3" : "#5274a5"}"/>
    </pattern>
    <linearGradient id="policy-reflection" x1="0" y1="0" x2="0.8" y2="1">
      <stop stop-color="#fff" stop-opacity="${dark ? 0.04 : 0.12}"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="${dark ? 0.006 : 0.015}"/>
      <stop offset="1" stop-color="#fff" stop-opacity="${dark ? 0.02 : 0.04}"/>
    </linearGradient>
    <filter id="policy-shadow" x="-10%" y="-20%" width="120%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="1" stdDeviation="0.65" flood-color="${dark ? "#000" : "#355078"}" flood-opacity="${dark ? 0.5 : 0.18}"/>
      <feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="${dark ? "#000" : "#355078"}" flood-opacity="${dark ? 0.4 : 0.14}"/>
    </filter>
    ${ambient}
    ${cards
      .map(({ left, top, width, height: cardHeight, radius }, index) => {
        const maps = glassMaps(width, cardHeight, radius);
        return `
      <clipPath id="policy-card-${index}">
        <rect x="${left}" y="${top}" width="${width}" height="${cardHeight}" rx="${radius}"/>
      </clipPath>
      <filter id="policy-glass-${index}" filterUnits="userSpaceOnUse" x="${left - 96}" y="${top - 96}"
        width="${width + 192}" height="${cardHeight + 192}" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="0.65" result="backdrop"/>
        <feImage x="${left}" y="${top}" width="${width}" height="${cardHeight}"
          href="${maps.displacement}" result="map"/>
        <feDisplacementMap in="backdrop" in2="map" scale="${maps.scale}" xChannelSelector="R" yChannelSelector="G" result="refracted"/>
        <feImage x="${left}" y="${top}" width="${width}" height="${cardHeight}"
          href="${maps.specular}" result="specular"/>
        <feColorMatrix in="refracted" type="saturate" values="1.5" result="saturated"/>
        <feComposite in="saturated" in2="specular" operator="in" result="edge-color"/>
        <feBlend in="edge-color" in2="refracted" mode="normal" result="edge-tinted"/>
        <feComponentTransfer in="specular" result="reflection">
          <feFuncA type="linear" slope="${dark ? 0.62 : 0.8}"/>
        </feComponentTransfer>
        <feBlend in="reflection" in2="edge-tinted" mode="normal"/>
      </filter>`;
      })
      .join("")}
  </defs>`;
  const surfaces = cards
    .map(({ left, top, width, height: cardHeight, radius }, index) => {
      const bounds = `x="${left}" y="${top}" width="${width}" height="${cardHeight}" rx="${radius}"`;
      return `<g>
      <rect ${bounds} fill="${dark ? "#111" : "#fff"}" fill-opacity="0.7" filter="url(#policy-shadow)"/>
      <g clip-path="url(#policy-card-${index})">
        <g filter="url(#policy-glass-${index})">
          <use href="#policy-ambient"/>
        </g>
        <rect ${bounds} fill="#111827" fill-opacity="${dark ? 0.2 : 0.055}"/>
        <rect ${bounds} fill="url(#policy-reflection)"/>
      </g>
    </g>`;
    })
    .join("");
  return `${definitions}<g clip-path="url(#policy-canvas)"><use href="#policy-ambient"/>${surfaces}</g>`;
}

export async function renderGlassDiagram(
  tree: JSXNode,
  theme: Theme,
  height: number,
  fonts: Font[],
): Promise<string> {
  const cards: GlassCard[] = [];
  const foreground = await satori(tree, {
    width: WIDTH,
    height,
    fonts,
    onNodeDetected({ left, top, width, height, props }) {
      const radius: unknown = props["data-glass-radius"];
      if (typeof radius === "number") cards.push({ left, top, width, height, radius });
    },
  });
  const rootEnd = foreground.indexOf(">") + 1;
  return (
    foreground.slice(0, rootEnd) + glassLayers(theme, height, cards) + foreground.slice(rootEnd)
  );
}
