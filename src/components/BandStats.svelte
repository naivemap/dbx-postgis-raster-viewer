<script>
  /**
   * 波段统计表（转置布局）：统计项为行、波段为列。
   * 首列标签 sticky 保持可见；切换波段或更换数据集后，滚动定位到当前波段列（居中）。
   */
  import { tr } from "../i18n.mjs";
  import { fmt } from "../shared.mjs";

  let { raster = null, band = 0 } = $props();

  let scrollEl = $state(null);

  /** 统计行定义：i18n 键 + 单元格取值函数。 */
  const rows = [
    ["statBandType", (b) => b.pixelType],
    ["statMin", (b) => fmt(b.stats.min)],
    ["statMax", (b) => fmt(b.stats.max)],
    ["statMean", (b) => fmt(b.stats.mean)],
    ["statStdDev", (b) => fmt(b.stats.stddev)],
    ["statValid", (b) => b.stats.count],
    ["statNodata", (b) => b.stats.nodataCount],
  ];

  // 当前波段列滚动到可视区中部（band / raster / scrollEl 均为响应式依赖）。
  $effect(() => {
    if (!scrollEl || !raster?.bands?.length) return;
    const cell = scrollEl.querySelector(`th[data-band="${band}"]`);
    if (!cell) return;
    const c = cell.getBoundingClientRect();
    const w = scrollEl.getBoundingClientRect();
    const left = scrollEl.scrollLeft + (c.left - w.left) + c.width / 2 - scrollEl.clientWidth / 2;
    scrollEl.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  });
</script>

<div class="stats-scroll" bind:this={scrollEl}>
  {#if raster && raster.bands.length > 0}
    <table class="stats">
      <thead>
        <tr>
          <th class="label">{tr("statBandName")}</th>
          {#each raster.bands as b}
            <th class:current={b.index === band} data-band={b.index}>Band {b.index + 1}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as [label, get]}
          <tr>
            <th class="label" scope="row">{tr(label)}</th>
            {#each raster.bands as b}
              <td class:current={b.index === band}>{get(b)}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <table class="stats">
      <tbody><tr><td colspan="2">{tr("noStats")}</td></tr></tbody>
    </table>
  {/if}
</div>
