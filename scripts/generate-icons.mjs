/**
 * 生成 PWA 图标和 favicon。
 *
 * 图形是「一叠记忆卡」：后面一张略微露出的卡片 + 前面一张写着三行字的卡片。
 * 「回忆」就是把知识装进卡片、再一张张想起来 —— 图标和界面用同一套语言。
 *
 * 不引任何图形库，直接手写 PNG 编码（zlib）+ 一个 SVG。
 * 运行：node scripts/generate-icons.mjs（或 npm run icons）
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "public");
mkdirSync(publicDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* PNG 编码（RGBA，无第三方库）                                         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 滤波方式
  ihdr[12] = 0; // 隔行扫描

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // 每行的滤波字节：0 = None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 图形                                                                */
/* ------------------------------------------------------------------ */

/**
 * 归一化坐标（0 ~ 1）下的图层，按从下到上的顺序叠：
 *   底 = 对角渐变的底色（取应用的两个主色：绿 → 蓝）
 *   中 = 后面一张卡（半透明白）
 *   上 = 前面一张卡（纯白）+ 卡上三行绿色文字行
 *
 * 图层都落在中心 80% 的安全区里，作为 maskable 图标（安卓自适应）也裁不坏。
 */
const LAYERS = [
  // 后面的卡：只露出右上角一点，制造「一叠卡」的感觉
  { x0: 0.40, y0: 0.16, x1: 0.82, y1: 0.64, r: 0.055, rgb: [255, 255, 255], alpha: 0.6 },
  // 前面的卡
  { x0: 0.18, y0: 0.28, x1: 0.66, y1: 0.84, r: 0.065, rgb: [255, 255, 255], alpha: 1 },
  // 卡上的三行字（越往下越短 —— 一张卡写一个知识点）
  { x0: 0.27, y0: 0.415, x1: 0.57, y1: 0.462, r: 0.0235, rgb: [0x26, 0x73, 0x4b], alpha: 1 },
  { x0: 0.27, y0: 0.515, x1: 0.51, y1: 0.562, r: 0.0235, rgb: [0x26, 0x73, 0x4b], alpha: 1 },
  { x0: 0.27, y0: 0.615, x1: 0.45, y1: 0.662, r: 0.0235, rgb: [0x26, 0x73, 0x4b], alpha: 1 },
];

const GRADIENT_FROM = [0x26, 0x73, 0x4b]; // 应用的 --green
const GRADIENT_TO = [0x4c, 0x7d, 0xbe]; // 偏蓝，对应 --blue 那一系

function inRoundRect(fx, fy, x0, y0, x1, y1, r) {
  if (fx < x0 || fx > x1 || fy < y0 || fy > y1) return false;
  const cx = Math.min(Math.max(fx, x0 + r), x1 - r);
  const cy = Math.min(Math.max(fy, y0 + r), y1 - r);
  const dx = fx - cx;
  const dy = fy - cy;
  return dx * dx + dy * dy <= r * r;
}

function gradientColor(t) {
  const k = Math.min(1, Math.max(0, t));
  return [
    GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * k,
    GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * k,
    GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * k,
  ];
}

/**
 * 超采样渲染：每像素取 superSample × superSample 个子采样点，
 * 用来把卡片和文字行的边缘混成平滑的过渡。
 */
function renderIcon(size, superSample = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = superSample * superSample;
  const total = size * superSample;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 底色：从左上的绿渐变到右下的蓝，和界面主色同一套
      const cx = (px + 0.5) / size;
      const cy = (py + 0.5) / size;
      const color = gradientColor((cx + cy) / 2);

      // 依次叠加各图层
      for (const layer of LAYERS) {
        let hits = 0;
        for (let sy = 0; sy < superSample; sy++) {
          const fy = (py * superSample + sy + 0.5) / total;
          for (let sx = 0; sx < superSample; sx++) {
            const fx = (px * superSample + sx + 0.5) / total;
            if (inRoundRect(fx, fy, layer.x0, layer.y0, layer.x1, layer.y1, layer.r)) hits++;
          }
        }
        const coverage = hits / samples;
        if (coverage <= 0) continue;
        const k = coverage * layer.alpha;
        for (let channel = 0; channel < 3; channel++) {
          color[channel] += (layer.rgb[channel] - color[channel]) * k;
        }
      }

      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(color[0]);
      rgba[offset + 1] = Math.round(color[1]);
      rgba[offset + 2] = Math.round(color[2]);
      rgba[offset + 3] = 255;
    }
  }

  return rgba;
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

for (const size of [192, 512]) {
  const png = encodePng(size, size, renderIcon(size));
  const target = resolve(publicDir, `icon-${size}.png`);
  writeFileSync(target, png);
  console.log(`已生成 ${target}（${png.length} 字节）`);
}

/*
 * favicon 用 SVG：同一套图形，同一个渐变。
 * 16px 下渐变几乎看不出过渡，但整体色调是对的 —— 标签页里一眼认得出。
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#26734b"/>
      <stop offset="1" stop-color="#4c7dbe"/>
    </linearGradient>
  </defs>
  <rect width="16" height="16" fill="url(#g)"/>
  <rect x="6.4" y="2.56" width="6.72" height="7.68" rx="0.88" fill="#ffffff" opacity="0.6"/>
  <rect x="2.88" y="4.48" width="7.68" height="8.96" rx="1.04" fill="#ffffff"/>
  <g fill="#26734b">
    <rect x="4.32" y="6.64" width="4.8" height="0.75" rx="0.375"/>
    <rect x="4.32" y="8.24" width="3.84" height="0.75" rx="0.375"/>
    <rect x="4.32" y="9.84" width="2.88" height="0.75" rx="0.375"/>
  </g>
</svg>
`;
writeFileSync(resolve(publicDir, "favicon.svg"), svg);
console.log(`已生成 ${resolve(publicDir, "favicon.svg")}`);
