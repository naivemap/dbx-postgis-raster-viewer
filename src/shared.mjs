/**
 * 工作台 / 输入页共享的纯函数（无 DOM、无响应式，供 Svelte 组件与单测复用）。
 */
import { bandPercentile, pixelToWorld } from "./lib/wkb-raster.mjs";
import { RAMPS } from "./lib/raster-render.mjs";
import { tr } from "./i18n.mjs";

/** 紧凑数值格式：6 位有效数字，非有限值显示为 —。 */
export const fmt = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : "—");

/**
 * 解析业务哨兵值输入（逗号分隔的数字串，兼容中文逗号与空白）。
 * @returns {Set<number>|null} 至少一个合法数字时返回集合，否则 null
 */
export function parseInvalidValues(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const values = text
    .split(/[,，]/)
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);
  return values.length > 0 ? new Set(values) : null;
}

/**
 * 拉伸区间：p2p98 走百分位，否则 Min–Max。
 * 业务哨兵值（invalidValues）视同 NaN 排除，避免极值压缩色带区间。
 *
 * @param {object} band 波段对象
 * @param {string} stretch 'minmax' | 'p2p98'
 * @param {Set<number>|null} [invalidSet] 业务哨兵值集合
 */
export function stretchRange(band, stretch, invalidSet = null) {
  if (stretch === "p2p98") {
    return {
      min: bandPercentile(band, 0.02, 200_000, invalidSet),
      max: bandPercentile(band, 0.98, 200_000, invalidSet),
    };
  }
  // minmax：无哨兵值时直接用预计算 stats（仅排除 NaN）
  if (!invalidSet || invalidSet.size === 0) {
    return { min: band.stats.min, max: band.stats.max };
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < band.values.length; i += 1) {
    const v = band.values[i];
    if (Number.isNaN(v) || invalidSet.has(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // 全部像元被排除时回落到统计区间（渲染为中点色）
  return {
    min: Number.isFinite(min) ? min : band.stats.min,
    max: Number.isFinite(max) ? max : band.stats.max,
  };
}

/** 用色带停靠点拼 CSS 线性渐变，作为色块的底色。 */
export function rampCssGradient(key) {
  const stops = RAMPS[key] ?? [];
  return `linear-gradient(to right, ${
    stops.map((s) => `rgb(${s.rgb.join(",")}) ${Math.round(s.p * 100)}%`).join(", ")
  })`;
}

/** 数据集显示名：优先 id/_id/name/title 属性，否则「列名[行号]」。 */
export function datasetName(dataset, meta) {
  const attrs = dataset.attributes;
  const key = Object.keys(attrs).find((k) => k === "id" || k.endsWith("_id") || k === "name" || k === "title");
  if (key !== undefined) return `${attrs[key]}`;
  return `${dataset.column}[${dataset.rowIndex + 1}]`;
}

/** 当前渲染波段索引（clamp 到有效范围）。仅单波段渲染。 */
export function renderBandIndices(raster, { band = 0 } = {}) {
  return [Math.min(band, raster.numBands - 1)];
}

/** 探针读数行：坐标 + 波段值（行列号 1 基；bands 为渲染波段索引，缺省全波段）。 */
export function makeProbeText(raster, col, row, bands = null) {
  const world = pixelToWorld(raster, col, row);
  const indices = bands ?? raster.bands.map((_, i) => i);
  const values = indices
    .map((i) => raster.bands[i])
    .filter(Boolean)
    .map((b) => `${b.pixelType}:${b.values[row * raster.width + col]}`)
    .join("  ");
  return `${tr("probeAt", { c: col + 1, r: row + 1, x: Number(world.x.toFixed(6)), y: Number(world.y.toFixed(6)) })}  |  ${values}`;
}

/** 重新取数前去掉原 SQL 尾部分号。 */
export function stripTrailingSemicolon(sql) {
  return String(sql ?? "").trim().replace(/;+\s*$/, "");
}
