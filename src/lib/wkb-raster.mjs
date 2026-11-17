/**
 * PostGIS WKB Raster（WKTRaster）二进制解析。
 *
 * 布局与 pg 扩展权威实现 pg/src/codec/raster.rs 保持一致（后者与
 * PostGIS rt_wkb.c 对齐）：
 *
 *   头部（固定 61 字节）：
 *     1B  端序（1=小端，0=大端）
 *     2B  版本（当前仅 0）
 *     2B  波段数 numBands
 *     8B  scaleX / scaleY / ipX / ipY / skewX / skewY（共 6 个 f64）
 *     4B  SRID
 *     2B  width
 *     2B  height
 *   逐波段：
 *     1B  pixtype（bit0-3 像素类型码 0-11；bit4(0x10) out-of-db；bit5(0x20) hasNodata）
 *     ?B  nodata —— 无论 hasNodata 是否置位，始终按像素类型字节数写入
 *     ?B  像素数据（行主序，无对齐填充）
 *
 * 位打包类型（1BB/2BUI/4BUI）像元按 MSB 先序紧凑排列（8/4/2 像元每字节），
 * 与 PostGIS rt_band_from_wkb 的打包方式一致；out-of-db 波段的“数据”仅是
 * 1 字节波段号，本解析器不支持解码但嗅探时可跳过。
 */

/** 像素类型表，按 PostGIS rt_pixtype 枚举码 0-11 索引。 */
export const PIXEL_TYPES = [
  { code: 0, name: "1BB", bytes: 1, bits: 1, kind: "uint", label: "1 位无符号" },
  { code: 1, name: "2BUI", bytes: 1, bits: 2, kind: "uint", label: "2 位无符号" },
  { code: 2, name: "4BUI", bytes: 1, bits: 4, kind: "uint", label: "4 位无符号" },
  { code: 3, name: "8BSI", bytes: 1, kind: "int", label: "8 位有符号" },
  { code: 4, name: "8BUI", bytes: 1, kind: "uint", label: "8 位无符号" },
  { code: 5, name: "16BSI", bytes: 2, kind: "int", label: "16 位有符号" },
  { code: 6, name: "16BUI", bytes: 2, kind: "uint", label: "16 位无符号" },
  { code: 7, name: "32BSI", bytes: 4, kind: "int", label: "32 位有符号" },
  { code: 8, name: "32BUI", bytes: 4, kind: "uint", label: "32 位无符号" },
  { code: 9, name: "16BF", bytes: 2, kind: "float", label: "16 位半精度浮点" },
  { code: 10, name: "32BF", bytes: 4, kind: "float", label: "32 位浮点" },
  { code: 11, name: "64BF", bytes: 8, kind: "float", label: "64 位浮点" },
];

const HEADER_SIZE = 61;

/** IEEE 754 半精度位串转 f64（次正规数、无穷、NaN 均正确处理）。 */
export function f16ToFloat64(bits) {
  const sign = bits >> 15;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    const v = frac * 2 ** -24;
    return sign ? -v : v;
  }
  if (exp === 0x1f) return frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
  return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * 十六进制字符串转字节。接受 PostgreSQL bytea 文本的 `\x` 前缀、
 * `0x` 前缀与 ASCII 空白；不合法（奇数长度、非十六进制字符）返回 null。
 * 查表 + 单遍扫描：严禁逐字节 slice/parseInt（每字节分配一个新字符串，
 * 数十 MB 的大结果会造成 GC 风暴、主线程长时间冻结）。
 */
const HEX_VALUE = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i += 1) HEX_VALUE[0x30 + i] = i;
for (let i = 0; i < 6; i += 1) {
  HEX_VALUE[0x41 + i] = 10 + i;
  HEX_VALUE[0x61 + i] = 10 + i;
}
const isWsCode = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d);

export function hexToBytes(hex) {
  if (typeof hex !== "string") return null;
  let s = hex.trim();
  if (s.startsWith("\\x") || s.startsWith("0x")) s = s.slice(2);
  const out = new Uint8Array(s.length >> 1);
  let o = 0;
  let acc = -1;
  for (let i = 0; i < s.length; i += 1) {
    const v = HEX_VALUE[s.charCodeAt(i)];
    if (v >= 0) {
      if (acc < 0) acc = v;
      else {
        out[o] = (acc << 4) | v;
        o += 1;
        acc = -1;
      }
    } else if (!isWsCode(s.charCodeAt(i))) {
      return null;
    }
  }
  if (o === 0 || acc >= 0) return null;
  return o === out.length ? out : out.subarray(0, o);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return hexToBytes(input);
  return null;
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 像素数据的字节长度（位打包类型按 ceil 紧凑计算）。 */
function dataByteSize(type, pixelCount) {
  return type.bits ? Math.ceil((pixelCount * type.bits) / 8) : pixelCount * type.bytes;
}

/** 按像素类型读取一个标量（用于 nodata；位打包类型取低有效位）。 */
function readScalar(view, offset, type, little) {
  switch (type.code) {
    case 0: return view.getUint8(offset) & 0x01;
    case 1: return view.getUint8(offset) & 0x03;
    case 2: return view.getUint8(offset) & 0x0f;
    case 3: return view.getInt8(offset);
    case 4: return view.getUint8(offset);
    case 5: return view.getInt16(offset, little);
    case 6: return view.getUint16(offset, little);
    case 7: return view.getInt32(offset, little);
    case 8: return view.getUint32(offset, little);
    case 9: return f16ToFloat64(view.getUint16(offset, little));
    case 10: return view.getFloat32(offset, little);
    case 11: return view.getFloat64(offset, little);
    default: return NaN;
  }
}

/** 读取整段像元数据为 Float64Array（行主序）。 */
function readPixelValues(view, offset, type, little, count) {
  const out = new Float64Array(count);
  switch (type.code) {
    case 0: // 1BB：8 像元/字节，MSB 先序
      for (let i = 0; i < count; i += 1) {
        const b = view.getUint8(offset + (i >> 3));
        out[i] = (b >> (7 - (i & 7))) & 1;
      }
      break;
    case 1: // 2BUI：4 像元/字节
      for (let i = 0; i < count; i += 1) {
        const b = view.getUint8(offset + (i >> 2));
        out[i] = (b >> (6 - ((i & 3) << 1))) & 3;
      }
      break;
    case 2: // 4BUI：2 像元/字节
      for (let i = 0; i < count; i += 1) {
        const b = view.getUint8(offset + (i >> 1));
        out[i] = (b >> (4 - ((i & 1) << 2))) & 0x0f;
      }
      break;
    case 3:
      for (let i = 0; i < count; i += 1) out[i] = view.getInt8(offset + i);
      break;
    case 4:
      for (let i = 0; i < count; i += 1) out[i] = view.getUint8(offset + i);
      break;
    case 5:
      for (let i = 0; i < count; i += 1) out[i] = view.getInt16(offset + i * 2, little);
      break;
    case 6:
      for (let i = 0; i < count; i += 1) out[i] = view.getUint16(offset + i * 2, little);
      break;
    case 7:
      for (let i = 0; i < count; i += 1) out[i] = view.getInt32(offset + i * 4, little);
      break;
    case 8:
      for (let i = 0; i < count; i += 1) out[i] = view.getUint32(offset + i * 4, little);
      break;
    case 9:
      for (let i = 0; i < count; i += 1) out[i] = f16ToFloat64(view.getUint16(offset + i * 2, little));
      break;
    case 10:
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(offset + i * 4, little);
      break;
    case 11:
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat64(offset + i * 8, little);
      break;
    default:
      break;
  }
  return out;
}

/** 解析 61 字节固定头。非法输入抛错（信息用中文，与 pg 侧对齐）。 */
function parseHeader(view, byteLength) {
  if (byteLength < HEADER_SIZE) {
    throw new Error(`WKB 过短：${byteLength} 字节（头部至少需要 ${HEADER_SIZE} 字节）`);
  }
  const endian = view.getUint8(0);
  if (endian !== 0 && endian !== 1) throw new Error(`无效的端序标记：${endian}`);
  const little = endian === 1;
  const version = view.getUint16(1, little);
  if (version !== 0) throw new Error(`不支持的 WKB Raster 版本：${version}`);
  const numBands = view.getUint16(3, little);
  const scaleX = view.getFloat64(5, little);
  const scaleY = view.getFloat64(13, little);
  const ipX = view.getFloat64(21, little);
  const ipY = view.getFloat64(29, little);
  const skewX = view.getFloat64(37, little);
  const skewY = view.getFloat64(45, little);
  const srid = view.getUint32(53, little);
  const width = view.getUint16(57, little);
  const height = view.getUint16(59, little);
  if (width === 0 || height === 0) throw new Error("宽度或高度为 0");
  return { little, version, numBands, scaleX, scaleY, ipX, ipY, skewX, skewY, srid, width, height };
}

/**
 * 遍历全部波段头（不读像元数据），返回每个波段的类型/标志/nodata
 * 与像元数据偏移。结构不完整时抛错。
 */
function readBandHeaders(view, header, byteLength) {
  const { little, numBands, width, height } = header;
  const pixelCount = width * height;
  const bands = [];
  let off = HEADER_SIZE;
  for (let b = 0; b < numBands; b += 1) {
    if (off + 1 > byteLength) throw new Error(`WKB 在第 ${b + 1} 波段描述处截断`);
    const ptByte = view.getUint8(off);
    off += 1;
    const code = ptByte & 0x0f;
    const type = PIXEL_TYPES[code];
    if (!type) throw new Error(`无效的像素类型码：${code}`);
    const isOffline = (ptByte & 0x10) !== 0;
    const hasNodata = (ptByte & 0x20) !== 0;
    if (off + type.bytes > byteLength) {
      throw new Error(`WKB 在第 ${b + 1} 波段 nodata 处截断：需要 ${type.bytes} 字节，剩余 ${byteLength - off}`);
    }
    const nodata = readScalar(view, off, type, little);
    off += type.bytes;
    // out-of-db 波段不携带像元数据，只有 1 字节波段号
    const dataSize = isOffline ? 1 : dataByteSize(type, pixelCount);
    if (off + dataSize > byteLength) {
      throw new Error(`WKB 在第 ${b + 1} 波段像元数据处截断：需要 ${dataSize} 字节（偏移 ${off}，共 ${byteLength} 字节）`);
    }
    bands.push({ index: b, type, isOffline, hasNodata, nodata, dataOffset: off, dataSize });
    off += dataSize;
  }
  return bands;
}

/**
 * 单遍统计（NaN 视为无效像元，计入 nodataCount）。
 * stddev 为总体标准差（÷n）。
 */
export function computeStats(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let nodataCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isNaN(v)) {
      nodataCount += 1;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    count += 1;
  }
  if (count === 0) return { min: NaN, max: NaN, mean: NaN, stddev: NaN, count: 0, nodataCount };
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return { min, max, mean, stddev: Math.sqrt(variance), count, nodataCount };
}

/**
 * 波段分位数（线性插值）。像元数超过 sampleCap 时按步长抽样，
 * 避免 Sortable 大数组的开销；无有效像元返回 null。
 *
 * @param {object} band 含 values(Float64Array) 的波段对象
 * @param {number} p 分位点 ∈ [0,1]
 * @param {number} [sampleCap=200000] 抽样上限
 * @param {Set<number>} [invalidSet] 业务哨兵值集合，命中视同 NaN 排除
 */
export function bandPercentile(band, p, sampleCap = 200_000, invalidSet = null) {
  const values = band.values;
  const stride = values.length > sampleCap ? Math.ceil(values.length / sampleCap) : 1;
  const valid = [];
  for (let i = 0; i < values.length; i += stride) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (invalidSet && invalidSet.has(v)) continue;
    valid.push(v);
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => a - b);
  const pos = (valid.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return valid[lo];
  return valid[lo] + (valid[hi] - valid[lo]) * (pos - lo);
}

/** 地理范围（北向上）；含旋转（skew≠0）返回 null。scale 符号自适应。 */
export function rasterExtent(geo) {
  const { ipX, ipY, scaleX, scaleY, skewX, skewY, width, height } = geo;
  if (Math.abs(skewX) > 1e-12 || Math.abs(skewY) > 1e-12) return null;
  const x0 = ipX;
  const x1 = ipX + scaleX * width;
  const y0 = ipY;
  const y1 = ipY + scaleY * height;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/**
 * 世界坐标 → 像元坐标（含 skew 的仿射逆变换），越界返回 null。
 * 正变换：x = ipX + col·scaleX + row·skewX；y = ipY + col·skewY + row·scaleY
 */
export function worldToPixel(raster, x, y) {
  const { scaleX: sx, scaleY: sy, skewX: kx, skewY: ky, ipX, ipY, width, height } = raster;
  const det = sx * sy - kx * ky;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  const dx = x - ipX;
  const dy = y - ipY;
  const col = Math.floor((dy * -kx + dx * sy) / det);
  const row = Math.floor((dy * sx - dx * ky) / det);
  if (col < 0 || row < 0 || col >= width || row >= height) return null;
  return { col, row };
}

/** 像元坐标 → 像元中心的世界坐标。 */
export function pixelToWorld(raster, col, row) {
  return {
    x: raster.ipX + (col + 0.5) * raster.scaleX + (row + 0.5) * raster.skewX,
    y: raster.ipY + (col + 0.5) * raster.skewY + (row + 0.5) * raster.scaleY,
  };
}

/**
 * 廉价的头部 + 波段头嗅探（不读像元数据），用于结果列的 raster 识别。
 * 任何结构不一致都返回 null，绝不抛错——调用方会把它用在任意单元格值上。
 */
export function rasterMetaFromWkb(input) {
  try {
    const bytes = toBytes(input);
    if (!bytes) return null;
    const view = dataView(bytes);
    const header = parseHeader(view, bytes.length);
    const bands = readBandHeaders(view, header, bytes.length);
    return buildMeta(header, bands, bytes.length);
  } catch {
    return null;
  }
}

/** 由头部 + 波段头组装与 rasterMetaFromWkb 同构的元数据对象。 */
function buildMeta(header, bands, byteLength) {
  return {
    width: header.width,
    height: header.height,
    srid: header.srid,
    scaleX: header.scaleX,
    scaleY: header.scaleY,
    ipX: header.ipX,
    ipY: header.ipY,
    skewX: header.skewX,
    skewY: header.skewY,
    numBands: header.numBands,
    littleEndian: header.little,
    byteLength,
    extent: rasterExtent(header),
    bands: bands.map((b) => ({
      pixelType: b.type.name,
      hasNodata: b.hasNodata,
      nodata: b.nodata,
      isOffline: b.isOffline,
    })),
  };
}

/** 只转换 hex 前缀至多 maxBytes 字节（跳过 ASCII 空白）；遇非法字符返回 null。 */
function hexPrefixToBytes(s, maxBytes) {
  const out = new Uint8Array(maxBytes);
  let o = 0;
  let acc = -1;
  for (let i = 0; i < s.length && o < maxBytes; i += 1) {
    const v = HEX_VALUE[s.charCodeAt(i)];
    if (v < 0) {
      if (!isWsCode(s.charCodeAt(i))) return null;
      continue;
    }
    if (acc < 0) acc = v;
    else {
      out[o] = (acc << 4) | v;
      o += 1;
      acc = -1;
    }
  }
  return o === maxBytes ? out : out.subarray(0, o);
}

/**
 * 轻量头部嗅探：按需转换头部与各波段头前缀，开销与整个 WKB 体量无关
 * （仅与最后一个波段头的偏移成正比）。供结果集扫描、数据集列表等对
 * 每个单元格调用的热路径使用；不校验像元载荷完整性（截断的栅格也能
 * 识别，选中时由全量解码报错）。
 * byteLength 为按结构推导的精确字节数（头 + Σ(波段头 + 像元数据)）。
 */
export function rasterMetaFromHexHead(hex) {
  try {
    if (typeof hex !== "string") return null;
    let s = hex.trim();
    if (s.startsWith("\\x") || s.startsWith("0x")) s = s.slice(2);
    const head = hexPrefixToBytes(s, HEADER_SIZE);
    if (!head || head.length < HEADER_SIZE) return null;
    const header = parseHeader(dataView(head), HEADER_SIZE);
    const { little, numBands, width, height } = header;
    const pixelCount = width * height;

    // 波段头不连续：第 b+1 个波段头位于第 b 个波段的像元数据之后。
    // 按需扩展前缀（1B pixtype + 最宽 8B nodata），像元数据只跳过不转换。
    let view = dataView(head);
    let viewLen = head.length;
    const bands = [];
    let off = HEADER_SIZE;
    for (let b = 0; b < numBands; b += 1) {
      if (off + 9 > viewLen) {
        const bytes = hexPrefixToBytes(s, off + 9);
        if (!bytes) return null;
        view = dataView(bytes);
        viewLen = bytes.length;
      }
      const ptByte = view.getUint8(off);
      const code = ptByte & 0x0f;
      const type = PIXEL_TYPES[code];
      if (!type) return null;
      const isOffline = (ptByte & 0x10) !== 0;
      const hasNodata = (ptByte & 0x20) !== 0;
      if (off + 1 + type.bytes > viewLen) return null; // 波段头/nodata 槽处截断
      const nodata = readScalar(view, off + 1, type, little);
      off += 1 + type.bytes;
      // out-of-db 波段不携带像元数据，只有 1 字节波段号
      const dataSize = isOffline ? 1 : dataByteSize(type, pixelCount);
      bands.push({ index: b, type, isOffline, hasNodata, nodata, dataOffset: off, dataSize });
      off += dataSize;
    }
    const byteLength = bands.reduce((sum, b) => sum + 1 + b.type.bytes + b.dataSize, HEADER_SIZE);
    return buildMeta(header, bands, byteLength);
  } catch {
    return null;
  }
}

/**
 * 全量解码：头部 + 每个波段的像元数组。
 *
 * 输出约定：每波段 values 为 Float64Array（行主序），nodata 命中与原始 NaN
 * 一律归一为 NaN（渲染与统计按 NaN 即无效处理）；nodata 原始值保留在
 * band.nodata 供元数据显示，hasNodata 标志单独保留。
 *
 * 掩膜语义与 pg/src/codec/raster.rs 对齐：PostGIS 序列化时无条件写 nodata
 * 槽，hasNodata 未置位时槽内常残留源数据的 nodata 值。置位时按槽值掩膜；
 * 未置位时仅当槽值非 0 才掩膜——0 是 PostGIS 波段未设置 nodata 时的初始
 * 槽值，直接掩膜会误伤有效的 0 值像元。
 *
 * @param {string|Uint8Array} input 十六进制（可含 \x / 0x 前缀与空白）或字节数组
 * @returns 解码后的栅格对象；输入不合法时抛 Error（中文信息）
 */
export function decodeRasterWkb(input) {
  const bytes = toBytes(input);
  if (!bytes) throw new Error("无效的十六进制输入");
  const view = dataView(bytes);
  const header = parseHeader(view, bytes.length);
  const bandHeaders = readBandHeaders(view, header, bytes.length);
  const pixelCount = header.width * header.height;

  const bands = bandHeaders.map((bh) => {
    if (bh.isOffline) throw new Error("out-of-db（离线）波段不受支持");
    const values = readPixelValues(view, bh.dataOffset, bh.type, header.little, pixelCount);
    const nodataActive = !Number.isNaN(bh.nodata) && (bh.hasNodata || bh.nodata !== 0);
    if (nodataActive) {
      for (let i = 0; i < pixelCount; i += 1) {
        if (values[i] === bh.nodata) values[i] = NaN;
      }
    }
    return {
      index: bh.index,
      pixelType: bh.type.name,
      pixelTypeCode: bh.type.code,
      kind: bh.type.kind,
      hasNodata: bh.hasNodata,
      nodata: bh.nodata,
      values,
      stats: computeStats(values),
    };
  });

  return {
    width: header.width,
    height: header.height,
    srid: header.srid,
    scaleX: header.scaleX,
    scaleY: header.scaleY,
    ipX: header.ipX,
    ipY: header.ipY,
    skewX: header.skewX,
    skewY: header.skewY,
    numBands: header.numBands,
    littleEndian: header.little,
    byteLength: bytes.length,
    bands,
    extent: rasterExtent(header),
  };
}
