/**
 * 栅格渲染（单波段灰度 / 色带）。
 *
 * 核心是纯函数 —— 只产出 RGBA 字节数组，不触碰 DOM，因此可以在 Node
 * 单测里直接断言；浏览器端再落位到 canvas。
 * 无效像元（nodata / NaN / 业务哨兵值）输出完全透明（alpha=0），
 * 由画布背景衬出白色。
 */

/**
 * 预设色带：归一化位置 p ∈ [0,1] 上的 RGB 停靠点（升序）。
 * gray 兜底（与 P1 灰度一致）；其余为常用科学可视化色带。
 */
export const RAMPS = {
  gray: [
    { p: 0, rgb: [0, 0, 0] },
    { p: 1, rgb: [255, 255, 255] },
  ],
  viridis: [
    { p: 0, rgb: [68, 1, 84] },
    { p: 0.25, rgb: [59, 82, 139] },
    { p: 0.5, rgb: [33, 145, 140] },
    { p: 0.75, rgb: [94, 201, 98] },
    { p: 1, rgb: [253, 231, 37] },
  ],
  turbo: [
    { p: 0, rgb: [48, 18, 59] },
    { p: 0.17, rgb: [68, 90, 204] },
    { p: 0.33, rgb: [25, 209, 190] },
    { p: 0.5, rgb: [78, 201, 76] },
    { p: 0.67, rgb: [215, 232, 43] },
    { p: 0.83, rgb: [252, 159, 20] },
    { p: 1, rgb: [122, 4, 3] },
  ],
  bluewhitered: [
    { p: 0, rgb: [5, 48, 97] },
    { p: 0.5, rgb: [247, 247, 247] },
    { p: 1, rgb: [178, 24, 43] },
  ],
  terrain: [
    { p: 0, rgb: [0, 104, 55] },
    { p: 0.4, rgb: [138, 196, 77] },
    { p: 0.7, rgb: [232, 229, 120] },
    { p: 1, rgb: [160, 67, 26] },
  ],
};

/** 解析色带入参：预设键名 / 停靠点数组 / falsy（→ 灰度）。 */
function resolveRamp(ramp) {
  if (!ramp) return RAMPS.gray;
  if (typeof ramp === "string") {
    const stops = RAMPS[ramp];
    if (!stops) throw new Error(`未知色带：${ramp}`);
    return stops;
  }
  if (Array.isArray(ramp) && ramp.length >= 2) return ramp;
  throw new Error("色带停靠点至少需要 2 个");
}

/**
 * 在色带上取样（t 先钳位到 [0,1]，停靠点间线性插值）。
 * @returns {[number, number, number]} RGB
 */
export function sampleRamp(stops, t) {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.p) return [...first.rgb];
  if (t >= last.p) return [...last.rgb];
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].p <= t) i += 1;
  const a = stops[i];
  const b = stops[i + 1];
  const span = b.p - a.p;
  const f = span > 0 ? (t - a.p) / span : 0;
  return [
    Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
    Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
    Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
  ];
}

/**
 * 生成色带条 RGBA（供 UI 渐变预览，宽 n 像素 × 1 行）。
 * @returns {Uint8ClampedArray} n×4
 */
export function rampGradient(ramp, n = 256) {
  const stops = resolveRamp(ramp);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    const [r, g, b] = sampleRamp(stops, n <= 1 ? 0 : i / (n - 1));
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  return out;
}

/** 值 → [0,1] 归一化；非法拉伸区间返回 0.5（渲染为中点色）。 */
function normalize(v, min, max) {
  const span = max - min;
  if (!(span > 0)) return 0.5;
  const t = (v - min) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 单波段渲染（灰度或色带）。
 *
 * @param {object} raster decodeRasterWkb 的输出
 * @param {number} bandIndex 波段序号（0 起）
 * @param {object} [options]
 * @param {number} [options.min] 拉伸下界，缺省用波段统计 min
 * @param {number} [options.max] 拉伸上界，缺省用波段统计 max
 * @param {string|Array} [options.ramp] 色带（预设键名或停靠点数组），缺省灰度
 * @param {Set<number>|number[]} [options.invalidValues] 业务哨兵值集合，命中视同 NaN 输出透明
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderBandToRGBA(raster, bandIndex, options = {}) {
  const band = raster?.bands?.[bandIndex];
  if (!band) throw new Error(`波段不存在：${bandIndex}`);
  const { width, height } = raster;
  const min = Number.isFinite(options.min) ? options.min : band.stats.min;
  const max = Number.isFinite(options.max) ? options.max : band.stats.max;
  const stops = resolveRamp(options.ramp);
  const gray = stops === RAMPS.gray;
  const invalidSet = options.invalidValues instanceof Set
    ? options.invalidValues
    : (options.invalidValues ? new Set(options.invalidValues) : null);
  const out = new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const v = band.values[i];
    if (Number.isNaN(v) || (invalidSet && invalidSet.has(v))) continue; // 无效像元保持 (0,0,0,0)
    const o = i * 4;
    const [r, g, b] = gray
      ? [128, 128, 128] // 占位，下方按灰度路径写 g
      : sampleRamp(stops, normalize(v, min, max));
    if (gray) {
      // 灰度路径：与 P1 行为一致（含常数波段中灰）
      const g = max - min > 0 ? Math.round(normalize(v, min, max) * 255) : 128;
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    } else {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
    out[o + 3] = 255;
  }
  return { width, height, data: out };
}

/** 渲染到 canvas（尺寸重置为栅格原生分辨率，CSS 负责缩放显示）。 */
export function drawBandToCanvas(canvas, raster, bandIndex, options) {
  const { width, height, data } = renderBandToRGBA(raster, bandIndex, options);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
}
