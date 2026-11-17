/**
 * 像元值表 — 行列双向虚拟化网格（对齐 postgis-viewer 的 PixelGrid 方案）。
 *
 * 与旧的「行级虚拟化 + table 文档流」的关键差异：
 *   - 滚动容器内只有两层：spacer（absolute、尺寸恒定，撑出总滚动范围）与
 *     layer（absolute，承载可见窗口内的单元格）；
 *   - 单元格是绝对定位 div，行列两个方向都只渲染与视口相交的部分；
 *   - spacer 尺寸只在 setRaster 时设定，滚动过程永不改变——没有逐帧变化的
 *     spacer 高度，浏览器滚动锚定无从触发，也就不会出现渲染窗口与滚动
 *     范围失配导致的空白；
 *   - 滚动经 requestAnimationFrame 合帧，每帧对 layer 做一次全量重绘
 *     （窗口内单元格数量有限，innerHTML 一次赋值比增量 DOM 状态机更快更稳）。
 */

const CELL_WIDTH = 80;
const CELL_HEIGHT = 24;
const HEADER_WIDTH = 56;
const HEADER_HEIGHT = 24;
/** 病态容器尺寸（如初始化期间不可见）时的窗口保护上限。 */
const MAX_WINDOW_CELLS = 6000;

/** 可见窗口计算（纯函数，供单测）。overscan 在可见范围四周各多渲染数列/行。 */
export function buildCellWindow({
  scrollLeft, scrollTop, viewportWidth, viewportHeight, totalCols, totalRows, overscan = 2,
}) {
  if (!(totalCols > 0) || !(totalRows > 0)) {
    return { firstCol: 0, lastCol: 0, firstRow: 0, lastRow: 0 };
  }
  const left = Math.max(0, scrollLeft);
  const top = Math.max(0, scrollTop);
  const width = Math.max(0, viewportWidth);
  const height = Math.max(0, viewportHeight);
  const firstCol = Math.max(0, Math.floor(left / CELL_WIDTH) - overscan);
  const lastCol = Math.min(totalCols, Math.ceil((left + width) / CELL_WIDTH) + overscan);
  const firstRow = Math.max(0, Math.floor(top / CELL_HEIGHT) - overscan);
  const lastRow = Math.min(totalRows, Math.ceil((top + height) / CELL_HEIGHT) + overscan);
  return { firstCol, lastCol, firstRow, lastRow };
}

/** 紧凑数值格式：整数原样、小数按用户选择的位数（默认 1 位）、极值走指数。 */
export function formatCell(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (Number.isInteger(number)) return String(number);
  const abs = Math.abs(number);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return number.toExponential(2);
  return number.toFixed(decimals);
}

export class PixelGrid {
  /**
   * @param {HTMLElement} container 滚动宿主；需 position:relative + overflow:auto
   * @param {{onCellHover?: Function, onCellClick?: Function, onGridLeave?: Function}} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.raster = null;
    this.bandIndex = 0;
    this.highlight = null;
    this.decimals = 1;

    this.spacer = document.createElement("div");
    this.spacer.className = "grid__spacer";
    this.layer = document.createElement("div");
    this.layer.className = "grid__layer";
    container.append(this.spacer, this.layer);

    this.onScroll = () => this.scheduleRender();
    container.addEventListener("scroll", this.onScroll, { passive: true });

    // 值单元格 hover / click（事件委托：innerHTML 全量重绘下无需逐节点挂监听）
    const pick = (event, handler) => {
      const target = event.target.closest?.(".grid__cell--value");
      if (!target) return;
      handler?.({ col: Number(target.dataset.col), row: Number(target.dataset.row) });
    };
    this.onCellOver = (event) => pick(event, this.options.onCellHover);
    this.onCellPick = (event) => pick(event, this.options.onCellClick);
    this.onGridLeave = () => this.options.onGridLeave?.(this.highlight ? { ...this.highlight } : null);
    this.layer.addEventListener("mouseover", this.onCellOver);
    this.layer.addEventListener("click", this.onCellPick);
    this.container.addEventListener("mouseleave", this.onGridLeave);
    this.frame = 0;
  }

  /** 绑定栅格与波段；raster 对象变化时重置滚动位置，仅波段变化时保留。 */
  setRaster(raster, bandIndex = 0) {
    const reset = raster !== this.raster;
    this.raster = raster;
    this.bandIndex = bandIndex;
    if (raster) {
      this.spacer.style.width = `${HEADER_WIDTH + raster.width * CELL_WIDTH}px`;
      this.spacer.style.height = `${HEADER_HEIGHT + raster.height * CELL_HEIGHT}px`;
    } else {
      this.spacer.style.width = "0";
      this.spacer.style.height = "0";
    }
    if (reset) {
      this.highlight = null;
      this.container.scrollTo({ left: 0, top: 0 });
    }
    this.render();
  }

  /** 固定高亮一个像元（col/row 为 0 基内部索引；传 null 清除）。 */
  setHighlight(col, row) {
    this.highlight = col === null || col === undefined ? null : { col, row };
    this.render();
  }

  /** 设置值显示的小数位数（0–6；整数与极值不受影响）。 */
  setDecimals(decimals) {
    this.decimals = Math.max(0, Math.min(6, Number.parseInt(decimals, 10) || 0));
    this.render();
  }

  /** 将像元滚动到视口中央（含冻结表头偏移；超出范围由浏览器自动截断）。 */
  scrollToCell(col, row) {
    const left = Math.max(0, HEADER_WIDTH + col * CELL_WIDTH - this.container.clientWidth / 2 + CELL_WIDTH / 2);
    const top = Math.max(0, HEADER_HEIGHT + row * CELL_HEIGHT - this.container.clientHeight / 2 + CELL_HEIGHT / 2);
    this.container.scrollTo({ left, top });
    this.render();
  }

  scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const raster = this.raster;
    if (!raster) {
      this.layer.replaceChildren();
      return;
    }
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = this.container;
    const win = buildCellWindow({
      scrollLeft,
      scrollTop,
      viewportWidth: clientWidth || 640,
      viewportHeight: clientHeight || 400,
      totalCols: raster.width,
      totalRows: raster.height,
    });
    const cols = win.lastCol - win.firstCol;
    const rows = win.lastRow - win.firstRow;
    if (cols <= 0 || rows <= 0 || cols * rows > MAX_WINDOW_CELLS) return;

    const band = raster.bands[this.bandIndex] ?? raster.bands[0];
    const values = band?.values;
    const parts = [];
    // 冻结表头行：列号（top 锚在 scrollTop，视觉上钉在顶部；与 PostGIS 像元坐标一致从 1 起）
    for (let col = win.firstCol; col < win.lastCol; col += 1) {
      parts.push(cell("grid__cell grid__cell--head",
        HEADER_WIDTH + col * CELL_WIDTH, scrollTop, CELL_WIDTH, HEADER_HEIGHT, String(col + 1)));
    }
    // 冻结表头列：行号（left 锚在 scrollLeft，视觉上钉在左侧）
    for (let row = win.firstRow; row < win.lastRow; row += 1) {
      parts.push(cell("grid__cell grid__cell--head",
        scrollLeft, HEADER_HEIGHT + row * CELL_HEIGHT, HEADER_WIDTH, CELL_HEIGHT, String(row + 1)));
    }
    // 左上角，压在两个表头之上
    parts.push(cell("grid__cell grid__cell--head grid__cell--corner",
      scrollLeft, scrollTop, HEADER_WIDTH, HEADER_HEIGHT, "#"));
    // 值单元格（nodata 已在解析层归一为 NaN；data-col/row 供事件委托，title 与表头同为 1 基）
    for (let row = win.firstRow; row < win.lastRow; row += 1) {
      const base = row * raster.width;
      for (let col = win.firstCol; col < win.lastCol; col += 1) {
        const v = values ? values[base + col] : Number.NaN;
        const nodata = Number.isNaN(v);
        const cls = [
          "grid__cell grid__cell--value",
          nodata ? "is-nodata" : "",
          this.highlight && this.highlight.col === col && this.highlight.row === row ? "is-active" : "",
        ].filter(Boolean).join(" ");
        parts.push(cell(cls,
          HEADER_WIDTH + col * CELL_WIDTH, HEADER_HEIGHT + row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT,
          nodata ? "—" : formatCell(v, this.decimals), { col, row }));
      }
    }
    this.layer.innerHTML = parts.join("");
  }

  destroy() {
    this.container.removeEventListener("scroll", this.onScroll);
    this.container.removeEventListener("mouseleave", this.onGridLeave);
    this.layer.removeEventListener("mouseover", this.onCellOver);
    this.layer.removeEventListener("click", this.onCellPick);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.spacer.remove();
    this.layer.remove();
  }
}

/** 文本全部来自数字格式化输出，无 HTML 注入面；data 供 hover/click 事件委托定位像元。 */
function cell(className, x, y, width, height, text, data = null) {
  const attrs = data
    ? ` data-col="${data.col}" data-row="${data.row}" title="col ${data.col + 1}, row ${data.row + 1}"`
    : "";
  return `<div class="${className}" style="left:${x}px;top:${y}px;width:${width}px;height:${height}px"${attrs}>${text}</div>`;
}
