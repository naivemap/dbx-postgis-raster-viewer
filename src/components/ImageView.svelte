<script>
  /**
   * 影像视图（单波段）：画布按栅格长宽比等比缩放铺满预览区（小图放大、大图缩小均适配）。
   * 探针（mousemove）读取像元值经 onProbe 上抛，mouseleave 经 onProbeLeave 复位。
   * 点击选中像元：DOM overlay 高亮标记（不触发重渲染），再点同一像元取消；
   * 选中经 onPixelSelect 上抛（null = 取消选中），波段/色带/拉伸变化保留选中。
   * 业务哨兵值（invalidValues，逗号分隔数字串）与 nodata 一样渲染为透明。
   */
  import { onMount } from "svelte";
  import { renderBandToRGBA } from "../lib/raster-render.mjs";
  import { stretchRange, makeProbeText, renderBandIndices, parseInvalidValues } from "../shared.mjs";

  let {
    raster = null,
    band = 0,
    ramp = "gray",
    stretch = "minmax",
    invalidValues = "",
    onProbe,
    onProbeLeave,
    onPixelSelect,
  } = $props();

  let canvas = $state(null);
  let wrap = $state(null);
  let selected = $state(null); // 选中的像元 {col, row}（0 基）；null = 未选中

  $effect(() => {
    renderImage();
  });

  // 切换数据集（raster 引用变化）时清除选中；渲染参数变化不产生依赖、不影响选中。
  $effect(() => {
    void raster;
    selected = null;
  });

  /** 选中标记的覆盖框样式（百分比定位，随画布缩放自适应）。 */
  const markerStyle = $derived.by(() => {
    if (!selected || !raster) return "";
    const x = (selected.col / raster.width) * 100;
    const y = (selected.row / raster.height) * 100;
    const w = 100 / raster.width;
    const h = 100 / raster.height;
    return `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
  });

  onMount(() => {
    const observer = new ResizeObserver(() => requestAnimationFrame(() => fitRasterCanvas()));
    observer.observe(wrap);
    return () => observer.disconnect();
  });

  function renderImage() {
    const r = raster;
    if (!r) {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
        canvas.style.width = "";
        canvas.style.height = "";
      }
      return;
    }
    if (!canvas) return;
    const bandData = r.bands[renderBandIndices(r, { band })[0]];
    if (!bandData) return;
    const invalidSet = parseInvalidValues(invalidValues);
    const { min, max } = stretchRange(bandData, stretch, invalidSet);
    const out = renderBandToRGBA(r, band, { min, max, ramp, invalidValues: invalidSet });
    canvas.width = out.width;
    canvas.height = out.height;
    canvas.getContext("2d").putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    fitRasterCanvas();
  }

  /** 画布按栅格长宽比等比缩放铺满预览区。 */
  function fitRasterCanvas() {
    if (!raster || !canvas || !canvas.width || !canvas.height || !wrap) return;
    const style = getComputedStyle(wrap);
    const availW = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availH = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / canvas.width, availH / canvas.height);
    const w = `${Math.max(1, Math.round(canvas.width * scale))}px`;
    const h = `${Math.max(1, Math.round(canvas.height * scale))}px`;
    if (canvas.style.width === w && canvas.style.height === h) return;
    canvas.style.width = w;
    canvas.style.height = h;
  }

  /** 事件坐标 → 栅格像元（0 基）；越界或无法换算时返回 null。 */
  function pixelFromEvent(event) {
    const r = raster;
    if (!r || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * r.width);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * r.height);
    if (col < 0 || row < 0 || col >= r.width || row >= r.height) return null;
    return { col, row };
  }

  function onMouseMove(event) {
    const px = pixelFromEvent(event);
    if (!px) return;
    onProbe?.({ col: px.col, row: px.row, text: makeProbeText(raster, px.col, px.row, renderBandIndices(raster, { band })) });
  }

  /** 点击选中：点像素选中，再点同一像元取消，点其他像元切换。 */
  function onClick(event) {
    const px = pixelFromEvent(event);
    if (!px) return;
    if (selected && selected.col === px.col && selected.row === px.row) {
      selected = null;
      onPixelSelect?.(null);
    } else {
      selected = px;
      onPixelSelect?.(px);
    }
  }
</script>

<div class="canvas-wrap" bind:this={wrap}>
  <div class="canvas-frame">
    <canvas
      id="raster-canvas"
      bind:this={canvas}
      onmousemove={onMouseMove}
      onmouseleave={() => onProbeLeave?.()}
      onclick={onClick}
    ></canvas>
    {#if selected && raster}
      <div class="pixel-marker" style={markerStyle}></div>
    {/if}
  </div>
</div>
