<script>
  /**
   * 左栏数据集列表。缩略图视口内才解码（IntersectionObserver，root 为列表自身），
   * 超预算的栅格保持棋盘格占位；点击切换选中数据集。
   */
  import { rasterMetaFromHexHead, decodeRasterWkb } from "../lib/wkb-raster.mjs";
  import { renderBandToRGBA } from "../lib/raster-render.mjs";
  import { formatBytes } from "../lib/analyze.mjs";
  import { THUMB_MAX_CELLS, THUMB_MAX_BYTES } from "../lib/budget.mjs";
  import { datasetName } from "../shared.mjs";

  let { rasters = [], active = -1, ramp = "gray", onSelect } = $props();

  /** 缩略图进入视口后解码渲染一次（与旧实现一致：用当时的色带，之后不追新）。 */
  function thumb(node) {
    const root = node.closest(".dataset-list");
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        renderThumbnail(node, Number(node.dataset.index));
      }
    }, { root, rootMargin: "80px" });
    observer.observe(node);
    return () => observer.disconnect();
  }

  function renderThumbnail(node, index) {
    const dataset = rasters[index];
    if (!dataset) return;
    const meta = rasterMetaFromHexHead(dataset.hex);
    if (
      !meta ||
      meta.width * meta.height > THUMB_MAX_CELLS ||
      meta.byteLength > THUMB_MAX_BYTES ||
      meta.bands.some((b) => b.isOffline)
    ) return;
    try {
      const raster = decodeRasterWkb(dataset.hex);
      const { data, width, height } = renderBandToRGBA(raster, 0, { ramp });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
      node.replaceChildren(canvas);
    } catch {
      /* 解码失败保持占位 */
    }
  }
</script>

<ul class="dataset-list">
  {#each rasters as dataset, index (dataset)}
    {@const meta = rasterMetaFromHexHead(dataset.hex)}
    {@const sub = meta
      ? `${meta.width}×${meta.height} · ${meta.numBands}B · ${meta.bands[0]?.pixelType ?? "?"}`
      : formatBytes(dataset.hex.length / 2)}
    <li>
      <button
        type="button"
        class="dataset-item"
        class:active={index === active}
        onclick={() => onSelect?.(index)}
      >
        <div class="dataset-thumb" data-index={index} use:thumb></div>
        <div class="dataset-info">
          <div class="dataset-name">{datasetName(dataset, meta)}</div>
          <div class="dataset-sub">{sub}</div>
        </div>
      </button>
    </li>
  {/each}
</ul>
