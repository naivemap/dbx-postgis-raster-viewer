/**
 * 把 DBX 结果快照转成可渲染的图层模型。
 *
 * result-view 收到的快照只有 { columns, rows, truncated }（加 context 根上的
 * connectionId / database / schema / sql）——没有 column_types，也没有
 * spatial_values。列类型只能从值本身恢复：
 *   - raster    → WKB Raster 头部严格校验（lib/wkb-raster.mjs 的 rasterMetaFromWkb）
 *   - geometry  → WKT / EWKT / hex-EWKB 嗅探（仅为识别出来并让路给内置预览）
 *
 * raster WKB 与 EWKB 同为 hex 传输，靠二进制头区分：raster 第 2-3 字节是
 * version，合法值只有 0；EWKB 该位置是几何类型码（1-7），二者无交集。
 */

import { rasterMetaFromHexHead } from "./wkb-raster.mjs";

export const KIND = {
  GEOMETRY: "geometry",
  RASTER: "raster",
  OTHER: "other",
};

const HEX_RE = /^[0-9a-fA-F]+$/;
const WKT_TYPE_RE = new RegExp(
  "^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\\b",
  "i",
);

/** 每列嗅探预算：非空样本数与累计字符数。 */
const SAMPLE_LIMIT = 40;
const SAMPLE_CHARS = 200_000;

/**
 * 按值形态分类单元格。
 * @returns {"rasterwkb" | "geometry" | null}
 */
export function sniffSpatialValue(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length < 5) return null;

  // WKT / EWKT（含 SRID=…; 前缀）。geometry 列在 DBX 中通常以 WKT 文本呈现。
  let head = text;
  if (head.toUpperCase().startsWith("SRID=")) {
    const semicolon = head.indexOf(";");
    if (semicolon < 0) return null;
    head = head.slice(semicolon + 1).trim();
  }
  if (WKT_TYPE_RE.test(head) && head.includes("(")) return "geometry";

  // hex 家族：先严格嗅探 raster，再嗅探 EWKB
  let hex = text;
  if (hex.startsWith("\\x") || hex.startsWith("0x")) hex = hex.slice(2);
  hex = hex.replace(/\s+/g, "");
  if (hex.length >= 18 && hex.length % 2 === 0 && HEX_RE.test(hex)) {
    if (rasterMetaFromHexHead(hex)) return "rasterwkb";
    if (isEwkbHeader(hex)) return "geometry";
  }
  return null;
}

/**
 * EWKB 头嗅探：首字节端序（0/1）+ 接下来 4 字节小端/大端 u32 类型码。
 * 低 6 位为几何类型（1-7）；高位仅允许 SRID(0x80000000) / Z(0x80000000 之外
 * 的 ISO 位)——宽松处理，只排除哈希/UUID 误判。
 */
function isEwkbHeader(hex) {
  const byteOrder = parseInt(hex.slice(0, 2), 16);
  if (byteOrder !== 0 && byteOrder !== 1) return false;
  const little = byteOrder === 1;
  const hexDigits = hex.slice(2, 10);
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const byte = parseInt(hexDigits.slice(i * 2, i * 2 + 2), 16);
    value |= little ? byte << (8 * i) : byte << (8 * (3 - i));
  }
  // JS 位运算带符号；SRID 标志位 0x80000000 会被推成负数，统一转无符号再判。
  value = value >>> 0;
  const typeId = value & 0x0fffffff;
  const flags = value >>> 28; // 高 4 位：仅 SRID(0x8) / M(0x4) / Z(0x2) 合法
  return typeId >= 1 && typeId <= 7 && flags <= 0xe;
}

/**
 * 分析结果快照的每一列。
 * @param {{columns: string[], rows: unknown[][]}} result
 * @returns {{columns: Array<{index:number,name:string,kind:string,samples:number,
 *   srid:number|null,raster:object|null}>,
 *   geometryColumns: number[], rasterColumns: number[]}}
 */
export function analyzeResult(result) {
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];

  const analyzed = columns.map((name, index) => analyzeColumn(name, index, rows));
  return {
    columns: analyzed,
    geometryColumns: analyzed.filter((c) => c.kind === KIND.GEOMETRY).map((c) => c.index),
    rasterColumns: analyzed.filter((c) => c.kind === KIND.RASTER).map((c) => c.index),
  };
}

function analyzeColumn(name, index, rows) {
  let geometryHits = 0;
  let rasterHits = 0;
  let viewed = 0;
  let budget = SAMPLE_CHARS;

  for (const row of rows) {
    if (viewed >= SAMPLE_LIMIT || budget <= 0) break;
    const raw = row?.[index];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") continue;
    viewed += 1;
    budget -= raw.length;

    const sniff = sniffSpatialValue(raw);
    if (sniff === "rasterwkb") rasterHits += 1;
    else if (sniff === "geometry") geometryHits += 1;
  }

  let kind = KIND.OTHER;
  if (rasterHits > 0) kind = KIND.RASTER;
  else if (geometryHits > 0) kind = KIND.GEOMETRY;

  return { index, name: name ?? `col_${index}`, kind, samples: viewed, raster: null };
}

/**
 * 收集结果集中每个 raster 单元格为一个"数据集"。
 * 同一行的非 raster 标量字段挂在 attributes 上，供数据集列表展示。
 * @returns {Array<{id:string,rowIndex:number,columnIndex:number,column:string,
 *   hex:string,attributes:Object<string,*>}>}
 */
export function buildRasters(result, rasterColumnIndices) {
  const rows = result?.rows ?? [];
  const columns = result?.columns ?? [];
  const rasters = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const columnIndex of rasterColumnIndices) {
      const raw = rows[rowIndex]?.[columnIndex];
      if (typeof raw !== "string") continue;
      const hex = raw.trim();
      if (!rasterMetaFromHexHead(hex)) continue;
      const attributes = {};
      for (let i = 0; i < columns.length; i += 1) {
        if (rasterColumnIndices.includes(i)) continue;
        const value = rows[rowIndex]?.[i];
        if (value === null || value === undefined || typeof value === "object") continue;
        attributes[columns[i] ?? `col_${i}`] = value;
      }
      rasters.push({
        id: `${rowIndex}:${columnIndex}`,
        rowIndex,
        columnIndex,
        column: columns[columnIndex] ?? `col_${columnIndex}`,
        hex,
        attributes,
      });
    }
  }
  return rasters;
}

/** 人可读字节大小。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
