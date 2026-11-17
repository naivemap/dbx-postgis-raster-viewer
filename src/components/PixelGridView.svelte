<script>
  /**
   * 像元值表视图：包装 lib/grid-table.mjs 的 PixelGrid（行列双向虚拟化）。
   * 面板 hidden 期间 clientWidth/Height 为 0，切回（active）时按真实视口重算窗口。
   */
  import { PixelGrid } from "../lib/grid-table.mjs";

  let {
    raster = null,
    band = 0,
    decimals = 1,
    active = false,
    onCellHover,
    onCellClick,
    onGridLeave,
  } = $props();

  let container = $state(null);
  let grid = $state(null);

  $effect(() => {
    if (!container) return;
    const instance = new PixelGrid(container, {
      onCellHover: (data) => onCellHover?.(data),
      onCellClick: (data) => onCellClick?.(data),
      onGridLeave: (data) => onGridLeave?.(data),
    });
    grid = instance;
    return () => {
      grid = null;
      instance.destroy();
    };
  });

  $effect(() => {
    grid?.setRaster(raster, band);
  });

  $effect(() => {
    grid?.setDecimals(decimals);
  });

  $effect(() => {
    if (active) requestAnimationFrame(() => grid?.render());
  });

  export function scrollToCell(col, row) {
    grid?.scrollToCell(col, row);
  }

  export function setHighlight(col, row) {
    grid?.setHighlight(col, row);
  }
</script>

<div class="grid-wrap" bind:this={container}></div>
