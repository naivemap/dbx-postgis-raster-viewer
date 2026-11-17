<script>
  /**
   * 元数据面板。source 为解码输出或头部嗅探结果（字段同构，超预算大栅格仍可展示元数据）；
   * 行内其他字段（≤8 个）一并列出。
   */
  import { tr } from "../i18n.mjs";
  import { formatBytes } from "../lib/analyze.mjs";

  let { dataset, source } = $props();

  /** 格式化浮点数：有效数字 + 去浮点噪声/尾零 */
  const fmt = (v, sig = 4) => (v == null || Number.isNaN(v) ? "—" : Number(v.toPrecision(sig)).toString());

  const items = $derived.by(() => {
    const r = source;
    if (!r) return [];
    const list = [
      [tr("sourceCell"), `row ${dataset.rowIndex + 1} · ${dataset.column}`],
      [tr("size"), `${r.width} × ${r.height}`],
      [tr("bandsCount"), String(r.numBands)],
      [tr("srid"), r.srid === 0 ? tr("sridUnknown") : String(r.srid)],
      [tr("origin"), `${fmt(r.ipX, 7)}, ${fmt(r.ipY, 7)}`],
      [tr("scale"), `${fmt(r.scaleX)}, ${fmt(r.scaleY)}`],
      [tr("extent"), r.extent ? r.extent.map((v) => fmt(v, 7)).join(", ") : "—"],
      [tr("skew"), `${fmt(r.skewX)}, ${fmt(r.skewY)}`],
      [tr("endian"), r.littleEndian ? tr("endianLe") : tr("endianBe")],
      [tr("bytes"), formatBytes(r.byteLength)],
    ];
    const attrKeys = Object.keys(dataset.attributes).filter((k) => k !== dataset.column).slice(0, 8);
    for (const key of attrKeys) list.push([key, String(dataset.attributes[key])]);
    return list;
  });
</script>

<div class="meta-grid">
  {#each items as [k, v]}
    <div><span class="k">{k}</span><span class="v">{v}</span></div>
  {/each}
</div>
