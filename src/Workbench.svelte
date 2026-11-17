<script>
  /**
   * PostGIS Raster Viewer — DBX result-view 工作台（三栏）。
   *
   * 快照契约：context = { result: { columns, rows, truncated }, connectionId,
   * database, schema, sql }。没有列类型，靠 lib/analyze.mjs 从值嗅探。
   * 布局：左 = 栅格数据集列表（每个 raster 单元格一条）；中 = 影像 / 像元值表
   * 两个视图页签；右 = 元数据、渲染调整（模式/波段/色带/RGB 通道/拉伸）、波段统计。
   * 工具栏「重新取数」经 host.queryData（host.data:read）原样重跑原查询——
   * 不对 SQL 做降采样改写；栅格超出客户端解码预算时不解码、仅提示。
   *
   * #workbench 根节点必须保持 flex:1 + min-height:0（见 app.css），
   * 否则像元值表的滚动高度链失效。
   */
  import { onMount } from "svelte";
  import { onContext, canQueryData, queryData, DataAccessError } from "./lib/host.mjs";
  import { analyzeResult, buildRasters } from "./lib/analyze.mjs";
  import { decodeRasterWkb, rasterMetaFromHexHead } from "./lib/wkb-raster.mjs";
  import { isDecodeOverBudget } from "./lib/budget.mjs";
  import { tr } from "./i18n.mjs";
  import { makeProbeText, renderBandIndices, stripTrailingSemicolon } from "./shared.mjs";
  import DatasetList from "./components/DatasetList.svelte";
  import ImageView from "./components/ImageView.svelte";
  import PixelGridView from "./components/PixelGridView.svelte";
  import MetaPanel from "./components/MetaPanel.svelte";
  import RenderControls from "./components/RenderControls.svelte";
  import BandStats from "./components/BandStats.svelte";

  let { context = null } = $props();

  let ctx = $state(null);        // 宿主上下文（result + 连接信息）
  let rasters = $state([]);      // buildRasters 输出
  let index = $state(-1);        // 当前选中数据集
  let dataset = $state(null);   // 当前选中数据集对象
  let raster = $state(null);    // decodeRasterWkb 输出；null = 未解码（过大或失败）
  let metaSource = $state(null); // 元数据面板数据源（解码输出或头部嗅探，字段同构）
  let band = $state(0);
  let ramp = $state("gray");
  let stretch = $state("minmax");
  let invalidValues = $state("");  // 业务哨兵值（逗号分隔），与 nodata 一样渲染为透明
  let view = $state("image");   // "image" | "grid"
  let noticeMsg = $state(null);  // { text, danger }
  let emptyState = $state(null); // { title, body, hint }
  let refreshing = $state(false);
  let probeText = $state("");
  let selectedCell = $state(null); // 影像视图选中的像元 {col, row}；null = 未选中
  let jumpCol = $state("");
  let jumpRow = $state("");
  let decimals = $state(1);
  let gridView = $state(null);  // PixelGridView 实例（bind:this）

  /** 探针读数行只显示当前渲染波段（仅单波段渲染）。 */
  const probeBands = $derived(raster ? renderBandIndices(raster, { band }) : null);
  /** 探针行常驻视图底部；无读数时按当前页签展示对应提示。 */
  const probeDisplay = $derived(probeText || (view === "grid" ? tr("gridHint") : tr("probeHint")));
  const sourceInfo = $derived.by(() => {
    const c = ctx ?? {};
    const parts = [];
    if (c.connectionId) parts.push(`conn ${String(c.connectionId).slice(0, 8)}`);
    if (c.database) parts.push(c.database);
    if (c.schema) parts.push(c.schema);
    const result = c.result;
    if (result) {
      const count = Array.isArray(result.rows) ? result.rows.length : 0;
      parts.push(`${count} ${tr("rows")}${result.truncated ? tr("truncated") : ""}`);
    }
    return { text: parts.join(" · "), title: typeof c.sql === "string" ? c.sql : "" };
  });

  onMount(() => {
    document.body.classList.add("wb-mode");
    if (context) {
      applyContext(context).catch((error) => {
        console.error("[raster-view] applyContext failed:", error);
        emptyState = { title: tr("fetchFailed"), body: `${error?.message ?? error}`, hint: "" };
      });
    } else {
      emptyState = { title: tr("loading"), body: "", hint: "" };
    }
    const off = onContext((next) => {
      if (next) void applyContext(next).catch((e) => setNotice(`${tr("fetchFailed")}: ${e?.message ?? e}`));
    });
    return () => {
      document.body.classList.remove("wb-mode");
      off();
    };
  });

  // ------------------------------------------------------------- 上下文应用

  async function applyContext(next) {
    ctx = next ?? {};
    noticeMsg = null;

    const result = ctx.result;
    if (!result || !Array.isArray(result.rows)) {
      emptyState = { title: tr("noRasterTitle"), body: tr("noRasterBody"), hint: tr("emptyHint") };
      return;
    }

    const analysis = analyzeResult(result);
    const { rasterColumns, geometryColumns } = analysis;
    if (rasterColumns.length === 0) {
      const onlyGeometry = geometryColumns.length > 0;
      emptyState = {
        title: onlyGeometry ? tr("geometryOnlyTitle") : tr("noRasterTitle"),
        body: onlyGeometry ? tr("geometryOnlyBody") : tr("noRasterBody"),
        hint: onlyGeometry ? "" : tr("emptyHint"),
      };
      return;
    }

    rasters = buildRasters(result, rasterColumns);
    console.debug("[raster-view] analysis:", {
      kinds: analysis.columns.map((c) => `${c.name}:${c.kind}`),
      datasets: rasters.length,
    });
    if (rasters.length === 0) {
      emptyState = { title: tr("noRasterTitle"), body: tr("noRasterBody"), hint: tr("emptyHint") };
      return;
    }

    emptyState = null;
    await selectDataset(Math.min(Math.max(index, 0), rasters.length - 1));
  }

  async function selectDataset(i) {
    const d = rasters[i];
    if (!d) return;
    index = i;
    dataset = d;
    selectedCell = null;

    // 先做轻量头部嗅探：超预算的大栅格不解码，直接提示（元数据仍可展示）。
    const meta = rasterMetaFromHexHead(d.hex);
    if (isDecodeOverBudget(meta)) {
      raster = null;
      metaSource = meta;
      setNotice(tr("tooLarge", { w: meta.width, h: meta.height, b: meta.numBands }));
      return;
    }

    try {
      raster = decodeRasterWkb(d.hex);
    } catch (error) {
      raster = null;
      metaSource = meta;
      setNotice(`${tr("decodeFailed")}: ${error.message}`);
      return;
    }
    noticeMsg = null;
    band = Math.min(band, raster.numBands - 1);
    metaSource = raster;
  }

  function setNotice(text, danger = true) {
    noticeMsg = { text, danger };
  }

  // ---------------------------------------------------------------- 探针联动

  /** 影像探针：读数 + 像元值表高亮联动（行列号展示与表头一致，从 1 起）。 */
  function onImageProbe({ col, row, text }) {
    probeText = text;
    gridView?.setHighlight(col, row);
  }

  function onImageProbeLeave() {
    // 鼠标移出影像：回落到选中像元读数；未选中则清空（展示页签提示）。
    probeText = selectedCell && raster
      ? makeProbeText(raster, selectedCell.col, selectedCell.row, probeBands)
      : "";
  }

  /** 影像点击选中：更新读数行（不做像元值表联动）。 */
  function onImageSelect(cell) {
    selectedCell = cell;
    probeText = cell && raster
      ? makeProbeText(raster, cell.col, cell.row, probeBands)
      : "";
  }

  /** 像元值表 hover：仅更新读数行（与表头一致，全波段值）。 */
  function onGridHover({ col, row }) {
    if (raster) probeText = makeProbeText(raster, col, row, probeBands);
  }

  /** 像元值表 click：固定高亮 + 更新读数行。 */
  function onGridClick({ col, row }) {
    gridView?.setHighlight(col, row);
    if (raster) probeText = makeProbeText(raster, col, row, probeBands);
  }

  /** 像元值表 leave：回落到选中像元读数；未选中则清空（展示页签提示）。 */
  function onGridLeave(cell) {
    probeText = cell && raster ? makeProbeText(raster, cell.col, cell.row) : "";
  }

  /** 行列号定位：输入 col/row（1 基），切到像元值表并滚动高亮。 */
  function jump() {
    const r = raster;
    if (!r) return;
    const col = Number.parseInt(jumpCol, 10);
    const row = Number.parseInt(jumpRow, 10);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return;
    // 输入为 1 基（与表头/读数一致），内部转 0 基后夹取
    const clampedCol = Math.max(0, Math.min(r.width - 1, col - 1));
    const clampedRow = Math.max(0, Math.min(r.height - 1, row - 1));
    view = "grid";
    gridView?.scrollToCell(clampedCol, clampedRow);
    gridView?.setHighlight(clampedCol, clampedRow);
    probeText = makeProbeText(r, clampedCol, clampedRow, renderBandIndices(r, { band }));
  }

  // ------------------------------------------------------------- 重新取数

  /**
   * 经 host.queryData 原样重跑原查询（不改写投影、不做降采样）。
   * 栅格超出客户端解码预算时在选中阶段提示，由用户自行在 SQL 中处理。
   */
  async function requery() {
    if (!canQueryData()) {
      setNotice(tr("hostTooOld"));
      return;
    }
    const base = stripTrailingSemicolon(ctx?.sql ?? "");
    if (!ctx?.connectionId || !base) {
      setNotice(tr("noConnection"));
      return;
    }

    const sql = `SELECT * FROM (${base}) AS pv_src LIMIT 200`;
    refreshing = true;
    try {
      const response = await queryData({
        connectionId: ctx.connectionId,
        database: ctx.database,
        schema: ctx.schema,
        sql,
        maxRows: 200,
      });
      if (Array.isArray(response?.rows) && response.rows.length > 0) {
        await applyContext({
          ...ctx,
          result: {
            columns: (response.columns ?? []).map((c) => (typeof c === "string" ? c : c?.name ?? "col")),
            rows: response.rows,
            truncated: response.truncated,
          },
        });
      } else {
        setNotice(`${tr("fetchFailed")}: 0 rows`);
      }
    } catch (error) {
      if (error instanceof DataAccessError && error.needsGrant) {
        setNotice(tr("needGrant"));
      } else {
        setNotice(`${tr("fetchFailed")}: ${error?.message ?? error}`);
      }
    } finally {
      refreshing = false;
    }
  }
</script>

<div id="workbench">
  <header class="wb-toolbar">
    <div class="wb-title">{tr("title")}</div>
    <div class="wb-source" title={sourceInfo.title}>{sourceInfo.text}</div>
    <button type="button" class="ghost" disabled={refreshing} onclick={() => void requery()}>
      {tr("refresh")}
    </button>
  </header>

  {#if noticeMsg}
    <div class="wb-notice" class:danger={noticeMsg.danger}>{noticeMsg.text}</div>
  {/if}

  {#if emptyState}
    <div class="wb-empty">
      <h2>{emptyState.title}</h2>
      {#if emptyState.body}<p>{emptyState.body}</p>{/if}
      {#if emptyState.hint}<pre>{emptyState.hint}</pre>{/if}
    </div>
  {:else}
    <div class="wb-layout">
      <aside class="wb-panel">
        <div class="wb-panel-title">{tr("datasets")}</div>
        <DatasetList {rasters} active={index} {ramp} onSelect={(i) => void selectDataset(i)} />
      </aside>

      <section class="wb-main wb-panel">
        <div class="view-tabs">
          <button type="button" class:active={view === "image"} onclick={() => (view = "image")}>
            {tr("viewImage")}
          </button>
          <button type="button" class:active={view === "grid"} onclick={() => (view = "grid")}>
            {tr("viewGrid")}
          </button>
        </div>
        <div class="view-stage">
          <div class="view-pane" hidden={view !== "image"}>
            <ImageView
              {raster}
              {band}
              {ramp}
              {stretch}
              {invalidValues}
              onProbe={onImageProbe}
              onProbeLeave={onImageProbeLeave}
              onPixelSelect={onImageSelect}
            />
          </div>
          <div class="view-pane" hidden={view !== "grid"}>
            <PixelGridView
              bind:this={gridView}
              {raster}
              {band}
              {decimals}
              active={view === "grid"}
              onCellHover={onGridHover}
              onCellClick={onGridClick}
              onGridLeave={onGridLeave}
            />
          </div>
          <div class="probe-bar">
            <div class="jump">
              <label for="jump-row">{tr("jump")}</label>
              <input
                type="number" id="jump-row" min="1" step="1" placeholder="row"
                bind:value={jumpRow}
                onkeydown={(e) => { if (e.key === "Enter") jump(); }}
              />
              <input
                type="number" min="1" step="1" placeholder="col"
                bind:value={jumpCol}
                onkeydown={(e) => { if (e.key === "Enter") jump(); }}
              />
              <button type="button" class="ghost" onclick={jump}>{tr("locate")}</button>
            </div>
            <div class="decimals">
              <label for="decimals-select">{tr("decimals")}</label>
              <select id="decimals-select" bind:value={decimals}>
                {#each [0, 1, 2, 3, 4, 5, 6] as d (d)}
                  <option value={d}>{d}</option>
                {/each}
              </select>
            </div>
            <div class="probe">{probeDisplay}</div>
          </div>
        </div>
      </section>

      <aside class="wb-panel wb-side">
        <section>
          <div class="wb-panel-title">{tr("metadata")}</div>
          {#if dataset && metaSource}
            <MetaPanel {dataset} source={metaSource} />
          {/if}
        </section>
        <section>
          <div class="wb-panel-title">{tr("render")}</div>
          <RenderControls {raster} bind:band bind:ramp bind:stretch bind:invalidValues />
        </section>
        <section>
          <div class="wb-panel-title">{tr("stats")}</div>
          <BandStats {raster} {band} />
        </section>
      </aside>
    </div>
  {/if}
</div>
