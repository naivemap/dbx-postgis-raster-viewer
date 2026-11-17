<script>
  /**
   * 渲染调整（仅单波段）：波段 / 色带（渐变色块）/ 拉伸 / 无效值。
   * band/ramp/stretch/invalidValues 为双向绑定。
   * 波段 nodata 值只读展示（与解码层掩膜语义一致）；
   * 业务哨兵值（无效值）输入后与 nodata 一样渲染为透明。
   */
  import { RAMPS, rampGradient } from "../lib/raster-render.mjs";
  import { tr } from "../i18n.mjs";
  import { fmt, stretchRange, rampCssGradient, parseInvalidValues } from "../shared.mjs";

  let {
    raster = null,
    band = $bindable(0),
    ramp = $bindable("gray"),
    stretch = $bindable("minmax"),
    invalidValues = $bindable(""),
  } = $props();

  /** 色带色块行：预设键 → i18n 标签键。 */
  const RAMP_LABELS = {
    gray: "rampGray",
    viridis: "rampViridis",
    turbo: "rampTurbo",
    bluewhitered: "rampBlueWhiteRed",
    terrain: "rampTerrain",
  };

  let preview = $state(null);

  /** 当前波段的 nodata：掩膜生效时显示值，否则显示未设置（与 decodeRasterWkb 语义一致）。 */
  const nodataText = $derived.by(() => {
    const bandData = raster?.bands?.[band];
    if (!bandData) return "—";
    const active = !Number.isNaN(bandData.nodata) && (bandData.hasNodata || bandData.nodata !== 0);
    return active ? fmt(bandData.nodata) : tr("nodataNotSet");
  });

  /** 当前波段在当前拉伸下的区间标注（色带预览条下方），哨兵值一并排除。 */
  const rangeLabels = $derived.by(() => {
    const bandData = raster?.bands?.[band];
    if (!bandData) return null;
    const { min, max } = stretchRange(bandData, stretch, parseInvalidValues(invalidValues));
    return [fmt(min), fmt(max)];
  });

  $effect(() => {
    if (!preview) return;
    preview.width = 256;
    preview.height = 1;
    preview.getContext("2d").putImageData(new ImageData(rampGradient(ramp, 256), 256, 1), 0, 0);
  });
</script>

<div class="render-controls">
  <label>
    <span>{tr("band")}</span>
    <select
      value={String(band)}
      onchange={(e) => (band = Number(e.target.value) || 0)}
    >
      {#each raster?.bands ?? [] as b}
        <option value={String(b.index)}>Band {b.index + 1} · {b.pixelType}</option>
      {/each}
    </select>
  </label>
  <div class="ramp-row">
    <span>{tr("ramp")}</span>
    <div class="ramp-swatches">
      {#each Object.keys(RAMPS) as key}
        {@const label = tr(RAMP_LABELS[key] ?? key)}
        <button
          type="button"
          class="swatch"
          class:selected={ramp === key}
          title={label}
          aria-label={`${tr("ramp")}: ${label}`}
          style:background={rampCssGradient(key)}
          onclick={() => (ramp = key)}
        ></button>
      {/each}
    </div>
  </div>
  <div class="ramp-preview-wrap">
    <canvas id="ramp-preview" bind:this={preview}></canvas>
    <div class="ramp-range">
      <span>{rangeLabels?.[0] ?? ""}</span>
      <span>{rangeLabels?.[1] ?? ""}</span>
    </div>
  </div>

  <label>
    <span>{tr("stretch")}</span>
    <select value={stretch} onchange={(e) => (stretch = e.target.value)}>
      <option value="minmax">{tr("stretchMinMax")}</option>
      <option value="p2p98">{tr("stretchPercent")}</option>
    </select>
  </label>

  <div class="readonly-row">
    <span>{tr("bandNodata")}</span>
    <span class="readonly-value">{nodataText}</span>
  </div>

  <label>
    <span>{tr("invalidValues")}</span>
    <input
      type="text"
      value={invalidValues}
      oninput={(e) => (invalidValues = e.target.value)}
      title={tr("invalidValuesHint")}
    />
  </label>
</div>
