/**
 * WKB Raster 解析层单测（零依赖，Node 直接运行）：
 *   node tools/selftest.mjs
 *
 * 构造器严格按 pg/src/codec/raster.rs 描述的线上格式拼字节：
 * 61 字节头（6 个 double）+ 逐波段 [pixtype(含标志位) | 按像素类型字节数的 nodata | 像素数据]。
 */
import {
  PIXEL_TYPES,
  hexToBytes,
  f16ToFloat64,
  rasterMetaFromWkb,
  rasterMetaFromHexHead,
  decodeRasterWkb,
  computeStats,
  bandPercentile,
  rasterExtent,
  worldToPixel,
  pixelToWorld,
} from "../src/lib/wkb-raster.mjs";
import {
  renderBandToRGBA, RAMPS, sampleRamp, rampGradient,
} from "../src/lib/raster-render.mjs";
import { parseInvalidValues, stretchRange } from "../src/shared.mjs";
import {
  sniffSpatialValue, analyzeResult, buildRasters, formatBytes, KIND,
} from "../src/lib/analyze.mjs";
import {
  isDecodeOverBudget, DECODE_MAX_CELLS, DECODE_MAX_BYTES,
} from "../src/lib/budget.mjs";
import { buildCellWindow, formatCell } from "../src/lib/grid-table.mjs";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
}

function approx(name, actual, expected, tolerance) {
  const tol = tolerance ?? Math.max(1e-9, 1e-9 * Math.abs(expected));
  if (Math.abs(actual - expected) <= tol) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}\n  expected ~${expected}\n  actual   ${actual}`);
}

/** NaN 视为相等的逐元素近似比较（relTol 供 f32 等低精度类型放宽）。 */
function checkValues(name, actual, expected, relTol = 1e-9) {
  if (!actual || actual.length !== expected.length) {
    failed += 1;
    console.error(`FAIL ${name}（长度不符）`);
    return;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (Number.isNaN(a) || Number.isNaN(e)) {
      if (Number.isNaN(a) !== Number.isNaN(e)) {
        failed += 1;
        console.error(`FAIL ${name}[${i}]: expected ~${e}, actual ${a}`);
        return;
      }
      continue;
    }
    if (Math.abs(a - e) > Math.max(relTol, relTol * Math.abs(e))) {
      failed += 1;
      console.error(`FAIL ${name}[${i}]: expected ~${e}, actual ${a}`);
      return;
    }
  }
  passed += 1;
}

function throws(name, fn, messagePart) {
  try {
    fn();
  } catch (error) {
    if (!messagePart || String(error.message).includes(messagePart)) {
      passed += 1;
    } else {
      failed += 1;
      console.error(`FAIL ${name}: 期待包含「${messagePart}」，实际「${error.message}」`);
    }
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}: 未抛出异常`);
}

// ---------------------------------------------------------------- 构造器

const TYPE_BY_NAME = new Map(PIXEL_TYPES.map((t) => [t.name, t]));

/** 像素值数组 → 原始字节。位打包类型按 MSB 先序；16BF 传入原始 u16 位型。 */
function encodeValues(values, typeName, little = true) {
  const t = TYPE_BY_NAME.get(typeName);
  if (t.bits) {
    const bytes = new Uint8Array(Math.ceil((values.length * t.bits) / 8));
    for (let i = 0; i < values.length; i += 1) {
      const slot = i % (8 / t.bits);
      const shift = 8 - t.bits * (slot + 1);
      bytes[Math.floor(i / (8 / t.bits))] |= (values[i] & ((1 << t.bits) - 1)) << shift;
    }
    return bytes;
  }
  const buf = new ArrayBuffer(values.length * t.bytes);
  const v = new DataView(buf);
  for (let i = 0; i < values.length; i += 1) {
    const o = i * t.bytes;
    const x = values[i];
    switch (typeName) {
      case "8BSI": v.setInt8(o, x); break;
      case "8BUI": v.setUint8(o, x); break;
      case "16BSI": v.setInt16(o, x, little); break;
      case "16BUI": v.setUint16(o, x, little); break;
      case "32BSI": v.setInt32(o, x, little); break;
      case "32BUI": v.setUint32(o, x, little); break;
      case "16BF": v.setUint16(o, x, little); break; // x 为原始位型
      case "32BF": v.setFloat32(o, x, little); break;
      case "64BF": v.setFloat64(o, x, little); break;
      default: throw new Error(`unsupported type ${typeName}`);
    }
  }
  return new Uint8Array(buf);
}

/** nodata 标量 → 按像素类型字节数的原始字节。
 *  位打包类型的 nodata 槽为原值单字节（低有效位），与 pg 扩展读取侧
 *  （raster.rs 的 & 0x01）及 wkb-raster.mjs readScalar 对称；
 *  MSB 位打包仅适用于像元数据，不适用于 nodata 槽。 */
function encodeNodata(value, typeName, little = true) {
  const t = TYPE_BY_NAME.get(typeName);
  if (t.bits) return new Uint8Array([value & ((1 << t.bits) - 1)]);
  return encodeValues([value], typeName, little);
}

function buildWkbRaster({
  width = 2,
  height = 2,
  srid = 4326,
  scaleX = 0.01,
  scaleY = -0.01,
  ipX = 116.3,
  ipY = 39.95,
  skewX = 0,
  skewY = 0,
  little = true,
  bands = [],
}) {
  const body = bands.map((b) => {
    const t = TYPE_BY_NAME.get(b.pixelType);
    const ptByte = t.code | (b.isOffline ? 0x10 : 0) | (b.hasNodata ? 0x20 : 0);
    const nodataBytes = encodeNodata(b.hasNodata ? (b.nodata ?? 0) : (b.nodata ?? 0), b.pixelType, little);
    const data = b.raw ?? encodeValues(b.values ?? [], b.pixelType, little);
    return [ptByte, [...nodataBytes], [...data]];
  }).flat(2);

  const size = 61 + body.length;
  const v = new DataView(new ArrayBuffer(size));
  let o = 0;
  v.setUint8(o++, little ? 1 : 0);
  v.setUint16(o, 0, little); o += 2;
  v.setUint16(o, bands.length, little); o += 2;
  v.setFloat64(o, scaleX, little); o += 8;
  v.setFloat64(o, scaleY, little); o += 8;
  v.setFloat64(o, ipX, little); o += 8;
  v.setFloat64(o, ipY, little); o += 8;
  v.setFloat64(o, skewX, little); o += 8;
  v.setFloat64(o, skewY, little); o += 8;
  v.setUint32(o, srid, little); o += 4;
  v.setUint16(o, width, little); o += 2;
  v.setUint16(o, height, little); o += 2;
  for (const b of body) v.setUint8(o++, b);
  return new Uint8Array(v.buffer);
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- hexToBytes

check("hex 基础", Array.from(hexToBytes("0102")), [1, 2]);
check("hex \\x 前缀", Array.from(hexToBytes("\\x0102")), [1, 2]);
check("hex 空白容忍", Array.from(hexToBytes("0102 0304\n0506")), [1, 2, 3, 4, 5, 6]);
check("hex 奇数长度", hexToBytes("abc"), null);
check("hex 非法字符", hexToBytes("zz"), null);
check("hex 空串", hexToBytes(""), null);

// ---------------------------------------------------------------- f16

approx("f16 1.0", f16ToFloat64(0x3c00), 1);
approx("f16 0.5", f16ToFloat64(0x3800), 0.5);
approx("f16 -2", f16ToFloat64(0xc000), -2);
check("f16 NaN", Number.isNaN(f16ToFloat64(0x7e00)), true);
approx("f16 最大有限值", f16ToFloat64(0x7bff), 65504);
approx("f16 次正规", f16ToFloat64(0x0001), 2 ** -24);

// ---------------------------------------------------------------- 嗅探

const sniffOk = buildWkbRaster({ width: 3, height: 2, bands: [{ pixelType: "32BF", hasNodata: true, nodata: -9999, values: [1, 2, 3, 4, 5, 6] }] });
const meta = rasterMetaFromWkb(sniffOk);
check("sniff 尺寸", meta && [meta.width, meta.height], [3, 2]);
check("sniff 波段类型", meta && meta.bands.map((b) => b.pixelType), ["32BF"]);
check("sniff hasNodata", meta && meta.bands[0].hasNodata, true);
check("sniff nodata", meta && meta.bands[0].nodata, -9999);
check("sniff 字节数", meta && meta.byteLength, sniffOk.length);
check("sniff 范围", meta && meta.extent, [116.3, 39.93, 116.33, 39.95]);

check("sniff 拒绝：过短", rasterMetaFromWkb("0102"), null);
check("sniff 拒绝：geometry EWKB", rasterMetaFromWkb("0101000020E6100000000000000000F03F0000000000000040"), null);
check("sniff 拒绝：md5 哈希", rasterMetaFromWkb("d41d8cd98f00b204e9800998ecf8427e"), null);
check("sniff 拒绝：非十六进制", rasterMetaFromWkb("hello world"), null);

const badEndian = buildWkbRaster({ bands: [{ pixelType: "8BUI", values: [1] }] });
badEndian[0] = 2;
check("sniff 拒绝：非法端序", rasterMetaFromWkb(badEndian), null);

const badVersion = buildWkbRaster({ bands: [{ pixelType: "8BUI", values: [1] }] });
badVersion[1] = 1; // version 低字节 → 1
check("sniff 拒绝：版本 1", rasterMetaFromWkb(badVersion), null);

// 像元数据截断：4×4 需要 16 字节，只给 2 字节
const truncated = buildWkbRaster({ width: 4, height: 4, bands: [{ pixelType: "8BUI", values: [1, 2] }] });
check("sniff 拒绝：像元截断", rasterMetaFromWkb(truncated), null);

// out-of-db 波段：嗅探通过（标记 isOffline），解码拒绝
const offline = buildWkbRaster({ bands: [{ pixelType: "8BUI", isOffline: true, hasNodata: false, raw: [1] }] });
const offlineMeta = rasterMetaFromWkb(offline);
check("sniff 接受 offline 标记", offlineMeta && offlineMeta.bands[0].isOffline, true);

// ------------------------------------------- 前缀嗅探 rasterMetaFromHexHead

// 回归：8×6 双波段。波段头不连续（波段 2 头位于波段 1 像元数据之后，
// 偏移 258），旧实现只转换 61+2×9=79 字节前缀导致越界、双波段被漏判
const dualHex = toHex(buildWkbRaster({
  width: 8,
  height: 6,
  bands: [
    { pixelType: "32BF", hasNodata: true, nodata: -9999, values: Array(48).fill(1.5) },
    { pixelType: "16BSI", nodata: 0, values: Array(48).fill(7) },
  ],
}));
const dualHead = rasterMetaFromHexHead(dualHex);
check("head 嗅探 双波段识别", !!dualHead, true);
check("head 嗅探 双波段尺寸", dualHead && [dualHead.width, dualHead.height], [8, 6]);
check("head 嗅探 双波段类型", dualHead && dualHead.bands.map((b) => b.pixelType), ["32BF", "16BSI"]);
check("head 嗅探 双波段 nodata", dualHead && dualHead.bands.map((b) => b.nodata), [-9999, 0]);
check("head 嗅探 双波段字节数", dualHead && dualHead.byteLength, 61 + (1 + 4 + 192) + (1 + 2 + 96));
check("head 嗅探 与全量一致", dualHead && JSON.stringify(dualHead), JSON.stringify(rasterMetaFromWkb(dualHex)));
check("head 嗅探 \\x 前缀", !!rasterMetaFromHexHead("\\x" + dualHex), true);

// 报错链路回归：sniffSpatialValue 依赖前缀嗅探判定栅格列
check("sniff 双波段 hex 判为栅格", sniffSpatialValue(dualHex), "rasterwkb");

// 末波段像元载荷不完整仍可嗅探（byteLength 按结构推导，选中时由全量解码报错）
const shortPayload = toHex(buildWkbRaster({ width: 4, height: 4, bands: [{ pixelType: "8BUI", values: [1, 2] }] }));
const shortMeta = rasterMetaFromHexHead(shortPayload);
check("head 嗅探 末波段像元截断仍识别", !!shortMeta, true);
check("head 嗅探 推导字节数", shortMeta && shortMeta.byteLength, 61 + 1 + 1 + 16);

// 波段 2 头（偏移 258，需 3 字节）被截断：只保留 259 字节 → 拒绝
check("head 嗅探 波段头截断拒绝", rasterMetaFromHexHead(dualHex.slice(0, 2 * (61 + 197 + 1))), null);

// 大端 + 8B nodata 槽 + 位打包混合双波段
const beDual = toHex(buildWkbRaster({
  little: false,
  width: 2,
  height: 2,
  bands: [
    { pixelType: "64BF", values: [1, 2, 3, 4] },
    { pixelType: "1BB", hasNodata: true, nodata: 1, values: [1, 0, 1, 0] },
  ],
}));
const beHead = rasterMetaFromHexHead(beDual);
check("head 嗅探 大端双波段类型", beHead && beHead.bands.map((b) => b.pixelType), ["64BF", "1BB"]);
check("head 嗅探 大端双波段 nodata", beHead && beHead.bands.map((b) => b.nodata), [0, 1]);

// 三波段位打包混合：验证多个不连续波段头向跳跃的正确性
const triHex = toHex(buildWkbRaster({
  width: 2,
  height: 2,
  bands: [
    { pixelType: "1BB", values: [1, 0, 1, 1] },
    { pixelType: "4BUI", hasNodata: true, nodata: 15, values: [1, 2, 3, 4] },
    { pixelType: "16BUI", values: [1000, 2000, 3000, 4000] },
  ],
}));
const triHead = rasterMetaFromHexHead(triHex);
check("head 嗅探 三波段位打包类型", triHead && triHead.bands.map((b) => b.pixelType), ["1BB", "4BUI", "16BUI"]);
check("head 嗅探 三波段字节数", triHead && triHead.byteLength, 61 + (1 + 1 + 1) + (1 + 1 + 2) + (1 + 2 + 8));

check("head 嗅探 拒绝非字符串", rasterMetaFromHexHead(null), null);
check("head 嗅探 拒绝 md5 哈希", rasterMetaFromHexHead("d41d8cd98f00b204e9800998ecf8427e"), null);

// ---------------------------------------------------------------- 头部解码

const headerWkb = buildWkbRaster({
  width: 3, height: 2, srid: 3857, scaleX: 0.5, scaleY: -0.25, ipX: 116, ipY: 40,
  bands: [{ pixelType: "8BUI", hasNodata: true, nodata: 255, values: [9, 200, 7, 1, 2, 3] }],
});
const header = decodeRasterWkb(headerWkb);
check("header 尺寸", [header.width, header.height], [3, 2]);
check("header srid", header.srid, 3857);
approx("header scaleX", header.scaleX, 0.5);
approx("header scaleY", header.scaleY, -0.25);
approx("header ipX", header.ipX, 116);
approx("header ipY", header.ipY, 40);
check("header 端序", header.littleEndian, true);
check("header 字节数", header.byteLength, headerWkb.length);
check("header 范围", header.extent, [116, 39.5, 117.5, 40]);

// 大端
const beWkb = buildWkbRaster({
  little: false, bands: [{ pixelType: "8BUI", hasNodata: true, nodata: 255, values: [1, 2, 3, 4] }],
});
const be = decodeRasterWkb(beWkb);
check("大端 端序标记", be.littleEndian, false);
check("大端 像元值", Array.from(be.bands[0].values), [1, 2, 3, 4]);
check("大端 nodata", be.bands[0].nodata, 255);

// ---------------------------------------------------------------- 全像素类型

const typeCases = [
  // expect 为掩膜后的值：命中 nodata 的位置为 NaN
  { pixelType: "1BB", values: [1, 0, 1, 1, 0, 0], nodata: 1, expect: [NaN, 0, NaN, NaN, 0, 0] },
  { pixelType: "2BUI", values: [3, 1, 2, 0, 3, 3], nodata: 3, expect: [NaN, 1, 2, 0, NaN, NaN] },
  { pixelType: "4BUI", values: [15, 0, 7, 8, 3, 12], nodata: 15, expect: [NaN, 0, 7, 8, 3, 12] },
  { pixelType: "8BSI", values: [-128, -1, 0, 127, -2, 5], nodata: -128, expect: [NaN, -1, 0, 127, -2, 5] },
  { pixelType: "8BUI", values: [0, 255, 17, 128, 1, 99], nodata: 255, expect: [0, NaN, 17, 128, 1, 99] },
  { pixelType: "16BSI", values: [-32768, -1, 32767, -9999, 256, 7], nodata: -32768, expect: [NaN, -1, 32767, -9999, 256, 7] },
  { pixelType: "16BUI", values: [65535, 0, 12345, 1, 40000, 65535], nodata: 65535, expect: [NaN, 0, 12345, 1, 40000, NaN] },
  { pixelType: "32BSI", values: [-2147483648, 2147483647, -9999, 0, 1, -1], nodata: -9999, expect: [-2147483648, 2147483647, NaN, 0, 1, -1] },
  { pixelType: "32BUI", values: [4294967295, 0, 123456789, 1, 2, 3], nodata: 0, expect: [4294967295, NaN, 123456789, 1, 2, 3] },
  // 16BF 传入原始位型，期望为换算后的数值
  { pixelType: "16BF", values: [0x3c00, 0x3800, 0xc000, 0x0000, 0x7e00, 0x7bff], nodata: 0, expect: [1, 0.5, -2, NaN, NaN, 65504] },
  // 32BF 用放宽容差（f32 有效位约 7 位）；nodata 为 NaN 时不掩膜
  { pixelType: "32BF", values: [1.5, -9999.5, 0, 3.14159, NaN, 1e20], nodata: NaN, expect: [1.5, -9999.5, 0, 3.14159, NaN, 1e20], relTol: 1e-6 },
  { pixelType: "64BF", values: [1.5, -12345.6789, 0, 1e300, -1e-300, 42], nodata: 42, expect: [1.5, -12345.6789, 0, 1e300, -1e-300, NaN] },
];
for (const c of typeCases) {
  const wkb = buildWkbRaster({ width: 3, height: 2, bands: [{ pixelType: c.pixelType, hasNodata: true, nodata: c.nodata, values: c.values }] });
  const r = decodeRasterWkb(wkb);
  check(`类型 ${c.pixelType} 名称`, r.bands[0].pixelType, c.pixelType);
  checkValues(`类型 ${c.pixelType} 像元值`, r.bands[0].values, c.expect, c.relTol);
}

// nodata 槽位字节数正确性（多波段混合类型偏移）
const multi = buildWkbRaster({
  width: 2, height: 1,
  bands: [
    { pixelType: "8BUI", hasNodata: true, nodata: 9, values: [9, 200] },
    { pixelType: "16BSI", hasNodata: false, nodata: -32768, values: [-300, 32767] },
  ],
});
const multiR = decodeRasterWkb(multi);
check("多波段 数量", multiR.numBands, 2);
check("多波段 波段1", Array.from(multiR.bands[0].values), [NaN, 200]);
check("多波段 波段2", Array.from(multiR.bands[1].values), [-300, 32767]);
check("多波段 字节数", multiR.byteLength, 61 + (1 + 1 + 2) + (1 + 2 + 4));

// ---------------------------------------------------------------- nodata 语义

const ndMasked = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: true, nodata: -9999, values: [-9999, 1, 2, 3] }] }));
check("nodata 掩膜", Array.from(ndMasked.bands[0].values).map((v) => Number.isNaN(v)), [true, false, false, false]);
check("nodata 掩膜统计", [ndMasked.bands[0].stats.min, ndMasked.bands[0].stats.max, ndMasked.bands[0].stats.nodataCount], [1, 3, 1]);

// 未置位但槽值非 0：视为源数据残留的 nodata，仍掩膜（对齐 pg 扩展读取约定）
const ndUnflaggedVal = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: false, nodata: -9999, values: [-9999, 1, 2, 3] }] }));
check("未置位槽值非0 掩膜", Array.from(ndUnflaggedVal.bands[0].values).map((v) => Number.isNaN(v)), [true, false, false, false]);
check("未置位槽值非0 统计", [ndUnflaggedVal.bands[0].stats.min, ndUnflaggedVal.bands[0].stats.nodataCount], [1, 1]);
check("未置位保留原始值", ndUnflaggedVal.bands[0].nodata, -9999);
check("未置位标志", ndUnflaggedVal.bands[0].hasNodata, false);

// 未置位且槽值为 0（PostGIS 未设置 nodata 的默认槽值）：不掩膜，保护有效 0 值
const ndUnflaggedZero = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: false, nodata: 0, values: [0, 1, 2, 3] }] }));
check("未置位槽值0 不掩膜", Array.from(ndUnflaggedZero.bands[0].values).map((v) => Number.isNaN(v)), [false, false, false, false]);
check("未置位槽值0 统计含0", ndUnflaggedZero.bands[0].stats.min, 0);

// GDAL 惯用 float32 nodata（9.969209968386869e+36）未置位场景回归
const ndGdal = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: false, nodata: 9.969209968386869e+36, values: [9.969209968386869e+36, 1.5, 2.5, 3.5] }] }));
check("GDAL float32 nodata 掩膜", Array.from(ndGdal.bands[0].values).map((v) => Number.isNaN(v)), [true, false, false, false]);
check("GDAL float32 nodata 统计", [ndGdal.bands[0].stats.min, ndGdal.bands[0].stats.max, ndGdal.bands[0].stats.nodataCount], [1.5, 3.5, 1]);

const ndNan = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: true, nodata: NaN, values: [NaN, 5, 6, 7] }] }));
check("NaN nodata 掩膜", ndNan.bands[0].stats.nodataCount, 1);
check("NaN nodata 有效值", ndNan.bands[0].stats.min, 5);

// ---------------------------------------------------------------- 错误路径

throws("错误：头截断", () => decodeRasterWkb(sniffOk.slice(0, 50)), "WKB 过短");
throws("错误：非法端序", () => decodeRasterWkb(badEndian), "端序");
throws("错误：版本", () => decodeRasterWkb(badVersion), "版本");
throws("错误：像元截断", () => decodeRasterWkb(truncated), "像元数据处截断");
throws("错误：out-of-db", () => decodeRasterWkb(offline), "out-of-db");
const badPixtype = buildWkbRaster({ bands: [{ pixelType: "8BUI", hasNodata: false, values: [1, 2, 3, 4] }] });
badPixtype[61] = 12 | 0x20; // pixtype 码 12 非法
throws("错误：非法像素类型码", () => decodeRasterWkb(badPixtype), "无效的像素类型码");

// ---------------------------------------------------------------- 统计

const stats = computeStats(Float64Array.from([1, 2, 3, 4, NaN]));
approx("stats min", stats.min, 1);
approx("stats max", stats.max, 4);
approx("stats mean", stats.mean, 2.5);
approx("stats stddev", stats.stddev, Math.sqrt(1.25));
check("stats count", stats.count, 4);
check("stats nodataCount", stats.nodataCount, 1);
const statsEmpty = computeStats(Float64Array.from([NaN, NaN]));
check("stats 全无效", [statsEmpty.count, statsEmpty.nodataCount], [0, 2]);

const pctBand = { values: Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) };
approx("percentile p0", bandPercentile(pctBand, 0), 1);
approx("percentile p0.5", bandPercentile(pctBand, 0.5), 5.5);
approx("percentile p1", bandPercentile(pctBand, 1), 10);
approx("percentile p0.02", bandPercentile(pctBand, 0.02), 1.18);
check("percentile 全无效", bandPercentile({ values: Float64Array.from([NaN]) }, 0.5), null);

// ---------------------------------------------------------------- 仿射与范围

const affineRaster = { ipX: 100, ipY: 40, scaleX: 0.01, scaleY: -0.01, skewX: 0, skewY: 0, width: 10, height: 10 };
// 用像元中心附近的点做判定，避开整数边界的浮点误差
check("worldToPixel 内部", worldToPixel(affineRaster, 100.055, 39.945), { col: 5, row: 5 });
check("worldToPixel 越界", worldToPixel(affineRaster, 100.11, 39.95), null);
approx("pixelToWorld x", pixelToWorld(affineRaster, 5, 5).x, 100.055);
approx("pixelToWorld y", pixelToWorld(affineRaster, 5, 5).y, 39.945);

const skewRaster = { ipX: 0, ipY: 0, scaleX: 1, scaleY: 1, skewX: 0.5, skewY: 0, width: 4, height: 4 };
const skewWorld = pixelToWorld(skewRaster, 2, 2);
approx("skew forward x", skewWorld.x, 3.75);
approx("skew forward y", skewWorld.y, 2.5);
check("skew 逆变换", worldToPixel(skewRaster, 3.75, 2.5), { col: 2, row: 2 });
check("skew 范围为 null", rasterExtent(skewRaster), null);
check("北向上范围", rasterExtent(affineRaster), [100, 39.9, 100.1, 40]);

// ---------------------------------------------------------------- 渲染

const renderRaster = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "32BF", hasNodata: true, nodata: -9999, values: [0, 127.5, -9999, 255] }] }));
const rgba = renderBandToRGBA(renderRaster, 0);
check("渲染 灰度与透明", Array.from(rgba.data), [0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 0, 255, 255, 255, 255]);

const stretched = renderBandToRGBA(renderRaster, 0, { min: 100, max: 200 });
check("渲染 拉伸覆盖", Array.from(stretched.data.slice(8)), [0, 0, 0, 0, 255, 255, 255, 255]);

const constRaster = decodeRasterWkb(buildWkbRaster({ bands: [{ pixelType: "8BUI", hasNodata: false, values: [7, 7, 7, 7] }] }));
const constRgba = renderBandToRGBA(constRaster, 0);
check("渲染 常数波段中灰", Array.from(constRgba.data.slice(0, 4)), [128, 128, 128, 255]);

throws("渲染 波段越界", () => renderBandToRGBA(renderRaster, 5), "波段不存在");

// ---------------------------------------------------------------- 空间值嗅探

const sniffRasterHex = toHex(buildWkbRaster({
  width: 3, height: 2,
  bands: [{ pixelType: "32BF", hasNodata: true, nodata: -9999, values: [1, 2, 3, 4, 5, 6] }],
}));
check("sniffValue raster hex", sniffSpatialValue(sniffRasterHex), "rasterwkb");
check("sniffValue raster \\x 前缀", sniffSpatialValue(`\\x${sniffRasterHex}`), "rasterwkb");
check("sniffValue WKT POINT", sniffSpatialValue("POINT(116 39)"), "geometry");
check("sniffValue WKT POLYGON", sniffSpatialValue("POLYGON ((0 0, 1 0, 1 1, 0 0))"), "geometry");
check("sniffValue EWKT", sniffSpatialValue("SRID=4326;POINT(116 39)"), "geometry");
check("sniffValue EWKB hex", sniffSpatialValue("0101000000000000000000F03F0000000000000040"), "geometry");
check("sniffValue EWKB 含 SRID 标志", sniffSpatialValue("0101000020E6100000000000000000F03F0000000000000040"), "geometry");
check("sniffValue md5", sniffSpatialValue("d41d8cd98f00b204e9800998ecf8427e"), null);
check("sniffValue UUID", sniffSpatialValue("550e8400e29b41d4a716446655440000"), null);
check("sniffValue 短串", sniffSpatialValue("abc"), null);
check("sniffValue 非字符串", sniffSpatialValue(null), null);
check("sniffValue 大端 raster", sniffSpatialValue(toHex(buildWkbRaster({
  little: false, bands: [{ pixelType: "8BUI", values: [1, 2, 3, 4] }],
}))), "rasterwkb");

// ---------------------------------------------------------------- 结果分析

const rasterHexA = toHex(buildWkbRaster({
  width: 2, height: 2,
  bands: [{ pixelType: "8BUI", hasNodata: true, nodata: 0, values: [1, 2, 3, 4] }],
}));
const rasterHexB = toHex(buildWkbRaster({
  width: 2, height: 2,
  bands: [{ pixelType: "16BSI", values: [5, 6, 7, 8] }],
}));
const sampleResult = {
  columns: ["id", "rast", "geom", "note"],
  rows: [
    [1, rasterHexA, "POINT(1 2)", "a"],
    [2, rasterHexB, "POINT(3 4)", null],
    [3, null, "LINESTRING(0 0, 1 1)", "c"],
  ],
};
const analysis = analyzeResult(sampleResult);
check("analyze 列类型", analysis.columns.map((c) => c.kind),
  [KIND.OTHER, KIND.RASTER, KIND.GEOMETRY, KIND.OTHER]);
check("analyze raster 列", analysis.rasterColumns, [1]);
check("analyze geometry 列", analysis.geometryColumns, [2]);

check("analyze 空结果", analyzeResult({ columns: [], rows: [] }), { columns: [], geometryColumns: [], rasterColumns: [] });

const onlyGeometry = analyzeResult({ columns: ["geom"], rows: [["MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))"]] });
check("analyze 仅几何列", onlyGeometry.rasterColumns, []);
check("analyze 仅几何列 kind", onlyGeometry.columns[0].kind, KIND.GEOMETRY);

// ---------------------------------------------------------------- 数据集收集

const rasters = buildRasters(sampleResult, [1]);
check("buildRasters 数量", rasters.length, 2);
check("buildRasters id", rasters.map((r) => r.id), ["0:1", "1:1"]);
check("buildRasters 列名", rasters[0].column, "rast");
check("buildRasters 属性标量", rasters[0].attributes, { id: 1, geom: "POINT(1 2)", note: "a" });
check("buildRasters 属性跳过 null", rasters[1].attributes, { id: 2, geom: "POINT(3 4)" });
check("buildRasters null 单元格跳过", buildRasters({ columns: ["r"], rows: [[null], [rasterHexA]] }, [0]).length, 1);
check("buildRasters 非 hex 拒绝", buildRasters({ columns: ["r"], rows: [["nope"], [rasterHexB]] }, [0]).length, 1);

// ---------------------------------------------------------------- 字节格式化

check("formatBytes B", formatBytes(512), "512 B");
check("formatBytes KiB", formatBytes(2048), "2.0 KiB");
check("formatBytes MiB", formatBytes(3 * 1024 * 1024), "3.00 MiB");
check("formatBytes 非法", formatBytes(NaN), "—");
check("formatBytes 负数", formatBytes(-1), "—");

// ---------------------------------------------------------------- 色带

check("色带 预设清单", Object.keys(RAMPS).sort(),
  ["bluewhitered", "gray", "terrain", "turbo", "viridis"]);

for (const [name, stops] of Object.entries(RAMPS)) {
  let ok = stops.length >= 2;
  for (let i = 0; i < stops.length; i += 1) {
    const s = stops[i];
    if (s.p < 0 || s.p > 1) ok = false;
    if (i > 0 && stops[i - 1].p >= s.p) ok = false;
    if (!Array.isArray(s.rgb) || s.rgb.length !== 3 || s.rgb.some((v) => v < 0 || v > 255)) ok = false;
  }
  check(`色带 结构 ${name}`, ok, true);
}

check("sampleRamp 起点", sampleRamp(RAMPS.gray, 0), [0, 0, 0]);
check("sampleRamp 终点", sampleRamp(RAMPS.gray, 1), [255, 255, 255]);
check("sampleRamp 中点插值", sampleRamp(RAMPS.gray, 0.5), [128, 128, 128]);
check("sampleRamp 蓝白红中点", sampleRamp(RAMPS.bluewhitered, 0.5), [247, 247, 247]);
check("sampleRamp 钳位下界", sampleRamp(RAMPS.gray, -1), [0, 0, 0]);
check("sampleRamp 钳位上界", sampleRamp(RAMPS.gray, 2), [255, 255, 255]);
check("sampleRamp 多停靠点插值", sampleRamp(RAMPS.viridis, 0.375), [46, 114, 140]);

// 色带渲染（renderRaster 值 [0, 127.5, NaN, 255]，默认拉伸 0–255）
const viridisRgba = renderBandToRGBA(renderRaster, 0, { ramp: "viridis" });
check("色带渲染 起点", Array.from(viridisRgba.data.slice(0, 4)), [68, 1, 84, 255]);
check("色带渲染 中点", Array.from(viridisRgba.data.slice(4, 8)), [33, 145, 140, 255]);
check("色带渲染 nodata 透明", Array.from(viridisRgba.data.slice(8, 12)), [0, 0, 0, 0]);
check("色带渲染 终点", Array.from(viridisRgba.data.slice(12)), [253, 231, 37, 255]);

const grayExplicit = renderBandToRGBA(renderRaster, 0, { ramp: "gray" });
check("色带渲染 gray 回归", Array.from(grayExplicit.data), Array.from(renderBandToRGBA(renderRaster, 0).data));

const constViridis = renderBandToRGBA(constRaster, 0, { ramp: "viridis" });
check("色带渲染 常数波段取中点色", Array.from(constViridis.data.slice(0, 4)), [33, 145, 140, 255]);

const customStops = [{ p: 0, rgb: [10, 20, 30] }, { p: 1, rgb: [110, 220, 30] }];
const customRgba = renderBandToRGBA(renderRaster, 0, { ramp: customStops });
check("色带渲染 自定义停靠点", Array.from(customRgba.data.slice(0, 4)), [10, 20, 30, 255]);

throws("色带 未知预设", () => renderBandToRGBA(renderRaster, 0, { ramp: "nope" }), "未知色带");
throws("色带 停靠点不足", () => rampGradient([{ p: 0, rgb: [0, 0, 0] }]), "至少");

const grad = rampGradient("viridis", 256);
check("rampGradient 长度", grad.length, 256 * 4);
check("rampGradient 起点色", Array.from(grad.slice(0, 4)), [68, 1, 84, 255]);
check("rampGradient 终点色", Array.from(grad.slice(255 * 4)), [253, 231, 37, 255]);
check("rampGradient 单样本", Array.from(rampGradient(RAMPS.turbo, 1)), [48, 18, 59, 255]);

// ---------------------------------------------------------------- 业务无效值（哨兵值）

// 无 nodata 标记，9999 为业务哨兵值：默认统计区间被其压缩
const invalidRaster = decodeRasterWkb(buildWkbRaster({
  bands: [{ pixelType: "32BF", values: [0, 9999, 200, 255] }],
}));
const invalidOut = renderBandToRGBA(invalidRaster, 0, { invalidValues: new Set([9999]) });
check("无效值 命中像元透明", Array.from(invalidOut.data.slice(4, 8)), [0, 0, 0, 0]);
check("无效值 其余像元不透明", invalidOut.data[3], 255);
check("无效值 其余像元着色", invalidOut.data[2], 0); // 拉伸区间 0–255，v=0 → 灰度 0
check("无效值 数组入参等价", Array.from(renderBandToRGBA(invalidRaster, 0, { invalidValues: [9999] }).data),
  Array.from(invalidOut.data));
check("无效值 未声明时正常渲染", renderBandToRGBA(invalidRaster, 0).data[7], 255);

// 拉伸区间排除哨兵值
const invalidBand = invalidRaster.bands[0];
check("stretchRange minmax 排除哨兵值", stretchRange(invalidBand, "minmax", new Set([9999])), { min: 0, max: 255 });
check("stretchRange minmax 无哨兵值回落统计", stretchRange(invalidBand, "minmax", null),
  { min: invalidBand.stats.min, max: invalidBand.stats.max });

const pctInvalid = { values: Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 9999]) };
approx("bandPercentile 排除哨兵值 p1", bandPercentile(pctInvalid, 1, 200_000, new Set([9999])), 9);
approx("bandPercentile 未排除 p1", bandPercentile(pctInvalid, 1), 9999);
approx("stretchRange p2p98 排除哨兵值 min", stretchRange(pctInvalid, "p2p98", new Set([9999])).min, 1.16);
approx("stretchRange p2p98 排除哨兵值 max", stretchRange(pctInvalid, "p2p98", new Set([9999])).max, 8.84);

// 哨兵值输入解析
check("parseInvalidValues 多值", [...parseInvalidValues("9999, -99")], [9999, -99]);
check("parseInvalidValues 中文逗号", [...parseInvalidValues("1，2")], [1, 2]);
check("parseInvalidValues 忽略非法片段", [...parseInvalidValues("99, x, -9")], [99, -9]);
check("parseInvalidValues 空", parseInvalidValues(""), null);
check("parseInvalidValues 纯非法", parseInvalidValues("abc"), null);

// ---------------------------------------------------------------- 虚拟滚动窗口

check("cellWindow 左上角", buildCellWindow({ scrollLeft: 0, scrollTop: 0, viewportWidth: 800, viewportHeight: 480, totalCols: 10000, totalRows: 10000 }),
  { firstCol: 0, lastCol: 12, firstRow: 0, lastRow: 22 });
check("cellWindow 中部", buildCellWindow({ scrollLeft: 80 * 5000, scrollTop: 24 * 5000, viewportWidth: 800, viewportHeight: 480, totalCols: 10000, totalRows: 10000 }),
  { firstCol: 4998, lastCol: 5012, firstRow: 4998, lastRow: 5022 });
check("cellWindow 底部", buildCellWindow({ scrollLeft: 80 * 9999, scrollTop: 24 * 9999, viewportWidth: 800, viewportHeight: 480, totalCols: 10000, totalRows: 10000 }),
  { firstCol: 9997, lastCol: 10000, firstRow: 9997, lastRow: 10000 });
check("cellWindow 视口大于总数", buildCellWindow({ scrollLeft: 0, scrollTop: 0, viewportWidth: 2400, viewportHeight: 2400, totalCols: 50, totalRows: 50 }),
  { firstCol: 0, lastCol: 32, firstRow: 0, lastRow: 50 });
check("cellWindow 零行列", buildCellWindow({ scrollLeft: 0, scrollTop: 0, viewportWidth: 800, viewportHeight: 480, totalCols: 10, totalRows: 0 }),
  { firstCol: 0, lastCol: 0, firstRow: 0, lastRow: 0 });
check("cellWindow 负滚动", buildCellWindow({ scrollLeft: -100, scrollTop: -24, viewportWidth: 800, viewportHeight: 480, totalCols: 100, totalRows: 100 }),
  { firstCol: 0, lastCol: 12, firstRow: 0, lastRow: 22 });

check("formatCell 整数", formatCell(5), "5");
check("formatCell 默认一位", formatCell(0.5), "0.5");
check("formatCell 默认一位舍入", formatCell(123.456), "123.5");
check("formatCell 指定四位", formatCell(0.5, 4), "0.5000");
check("formatCell 指定两位", formatCell(123.456, 2), "123.46");
check("formatCell 整数不受位数影响", formatCell(5, 3), "5");
check("formatCell 指数", formatCell(2e-7), "2.00e-7");
check("formatCell NaN", formatCell(Number.NaN), "—");

// ---------------------------------------------------------------- 解码预算

check("budget 常量", [DECODE_MAX_CELLS, DECODE_MAX_BYTES], [4_000_000, 8 * 1024 * 1024]);
check("budget 小栅格", isDecodeOverBudget({ width: 1024, height: 1024, numBands: 3, byteLength: 3 * 1024 * 1024 }), false);
check("budget 超像元", isDecodeOverBudget({ width: 3000, height: 2000, numBands: 1, byteLength: 1 }), true);
check("budget 超字节", isDecodeOverBudget({ width: 100, height: 100, numBands: 1, byteLength: 16 * 1024 * 1024 }), true);
check("budget null meta", isDecodeOverBudget(null), false);


// ---------------------------------------------------------------- 汇总

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
