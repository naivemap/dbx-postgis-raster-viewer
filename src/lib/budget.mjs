/**
 * 客户端解码预算（纯常量与判定，供 UI 与 Node 单测共享）。
 *
 * 全量解码预算（像元数 × 波段数 / WKB 字节数）：超出仅提示，不卡 UI；
 * 缩略图预算低于全量预算，超出的数据集在列表中保持棋盘格占位。
 */

/** 缩略图解码上限：超出则用棋盘格占位。 */
export const THUMB_MAX_CELLS = 512 * 512;
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;

/** 全量解码预算。 */
export const DECODE_MAX_CELLS = 4_000_000;
export const DECODE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 是否超出客户端全量解码预算（像元 × 波段 或 WKB 字节数）。
 * meta 为 null（嗅探失败）时交由解码器抛错，不在此拦截。
 */
export function isDecodeOverBudget(meta) {
  if (!meta) return false;
  const cells = meta.width * meta.height * Math.max(1, meta.numBands);
  return cells > DECODE_MAX_CELLS || meta.byteLength > DECODE_MAX_BYTES;
}
