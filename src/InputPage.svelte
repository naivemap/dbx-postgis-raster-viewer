<script>
  /**
   * 外部 WKB 输入页（workbench / 浏览器直开场景）。
   *
   * 仅作为输入来源：粘贴 ST_AsBinary(rast) 十六进制文本，或打开十六进制 /
   * 二进制 WKB 文件。输入经头部嗅探确认有效后「在工作台中打开」——包装成
   * 宿主快照形状直通 mount(Workbench)，元数据、统计、渲染等工作台已具备
   * 的能力不在本页重复实现。
   */
  import { onMount, mount, tick } from "svelte";
  import { rasterMetaFromWkb } from "./lib/wkb-raster.mjs";
  import { formatBytes } from "./lib/analyze.mjs";
  import { host, canQueryData, listConnections, queryData, DataAccessError } from "./lib/host.mjs";

  let hex = $state("");
  let workbenchOpen = $state(false);
  let workbenchHost = $state(null);
  let workbenchError = $state("");
  let unmountWorkbench = null;
  let fileEl = $state(null);
  let dragover = $state(false);
  let mode = $state(!!host() && canQueryData() ? "sql" : "wkb"); // "wkb" | "sql"
  let connections = $state([]);
  let connId = $state("");
  let sqlText = $state("");
  let sqlRunning = $state(false);
  let sqlError = $state("");
  let wbSourceHint = $state("");

  const sqlSupported = !!host() && canQueryData();

  onMount(() => {
    document.body.classList.add("input-mode");
    if (mode === "sql") void loadConnections();
    return () => document.body.classList.remove("input-mode");
  });

  /** 拉取宿主连接列表（仅 PostGIS 相关库），默认选中首个已连接项。 */
  async function loadConnections() {
    try {
      const list = await listConnections();
      connections = list.filter((c) => String(c?.dbType ?? "").toLowerCase().includes("postg"));
      const preferred = connections.find((c) => c?.connected) ?? connections[0];
      connId = preferred?.id ?? "";
    } catch (e) {
      sqlError = `连接列表获取失败：${e?.message ?? e}`;
    }
  }

  /** 头部嗅探（不做全量像元解码，大输入也不卡）；hex 非空但嗅探失败时提示。 */
  const meta = $derived.by(() => {
    const text = hex.trim();
    return text ? rasterMetaFromWkb(text) : null;
  });
  const parseError = $derived(
    hex.trim() && !meta
      ? "未识别为 PostGIS Raster WKB：请确认是 ST_AsBinary(rast) 的完整十六进制输出。"
      : "",
  );
  const summary = $derived(
    meta
      ? `${meta.width} × ${meta.height} · ${meta.numBands} 波段（${meta.bands.map((b) => b.pixelType).join("/")}） · ${formatBytes(meta.byteLength)}`
      : "",
  );

  /** 同页动态挂载工作台（两种输入来源共用）。 */
  async function mountWorkbench(context, hint) {
    workbenchOpen = true;
    wbSourceHint = hint;
    document.body.classList.remove("input-mode");
    await tick();
    const { default: Workbench } = await import("./Workbench.svelte");
    unmountWorkbench = mount(Workbench, { target: workbenchHost, props: { context } });
  }

  /**
   * 直通：把当前输入的 WKB 包装成 Workbench 快照契约（单行单 raster 列）。
   * hex 原样传递——解析链路对 \x 前缀 / 空白自带清洗。
   */
  async function openInWorkbench() {
    if (!meta) return;
    workbenchError = "";
    try {
      await mountWorkbench(
        {
          connectionId: "local",
          database: "local",
          schema: "public",
          sql: "-- InputPage 直通：外部输入的 WKB",
          result: { columns: ["id", "rast"], rows: [[1, hex]], truncated: false },
        },
        "数据来自外部输入的 WKB；无宿主环境，重新取数不可用",
      );
    } catch (e) {
      closeWorkbench();
      workbenchError = `工作台加载失败：${e?.message ?? e}`;
    }
  }

  /**
   * SQL 模式：经 host.queryData 取回结果（绕开 result-view 的 2MB 快照限制，
   * 单次上限约 8MB 序列化载荷），包装成同一契约后挂载工作台。
   */
  async function runSql() {
    const sql = sqlText.trim();
    if (!connId || !sql || sqlRunning) return;
    sqlError = "";
    sqlRunning = true;
    try {
      const response = await queryData({ connectionId: connId, sql, maxRows: 200 });
      if (!Array.isArray(response?.rows) || response.rows.length === 0) {
        sqlError = "查询未返回数据行";
        return;
      }
      const conn = connections.find((c) => c?.id === connId);
      await mountWorkbench(
        {
          connectionId: connId,
          database: conn?.database,
          schema: conn?.schema,
          sql,
          result: {
            columns: (response.columns ?? []).map((c) => (typeof c === "string" ? c : c?.name ?? "col")),
            rows: response.rows,
            truncated: response.truncated,
          },
        },
        "数据来自 SQL 查询（经宿主通道取回）；工具栏「重新取数」可重跑",
      );
    } catch (e) {
      if (e instanceof DataAccessError && e.needsGrant) {
        sqlError = "数据访问未授权：请在宿主弹窗中允许本插件访问该连接后重试";
      } else {
        sqlError = `查询失败：${e?.message ?? e}`;
      }
    } finally {
      sqlRunning = false;
    }
  }

  function closeWorkbench() {
    try {
      unmountWorkbench?.();
    } catch {
      /* 卸载异常不阻断返回 */
    }
    unmountWorkbench = null;
    workbenchOpen = false;
    document.body.classList.remove("wb-mode");
    document.body.classList.add("input-mode");
  }

  /** 打开文件：全 ASCII 十六进制文本按文本读，否则视为二进制 WKB 就地转十六进制。 */
  async function loadFile(file) {
    if (!file) return;
    workbenchError = "";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      hex = isHexText(bytes) ? new TextDecoder().decode(bytes) : bytesToHex(bytes);
    } catch (e) {
      workbenchError = `文件读取失败：${e?.message ?? e}`;
    }
  }

  /** 拖放文件：与「打开文件」共用 loadFile，hex 文本 / 二进制 WKB 均可。 */
  function onDrop(e) {
    e.preventDefault();
    dragover = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  }

  function isHexText(bytes) {
    for (const b of bytes) {
      const isHex = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
      const isPad = b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20 || b === 0x5c || b === 0x78;
      if (!isHex && !isPad) return false;
    }
    return true;
  }

  function bytesToHex(bytes) {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  /** 构造 8×6 双波段示例（32BF 带 nodata + 16BSI），布局严格按规范。 */
  function buildSampleHex() {
    const width = 8;
    const height = 6;
    const band1 = new Float32Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        band1[r * width + c] =
          100 + 60 * Math.sin((c / (width - 1)) * Math.PI) + 40 * Math.cos((r / (height - 1)) * Math.PI);
      }
    }
    band1[2 * width + 3] = -9999; // nodata 命中
    band1[1 * width + 5] = NaN; // 原始 NaN 同样按无效处理
    const band2 = new Int16Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) band2[r * width + c] = r * 50 + c * 10;
    }

    const size = 61 + (1 + 4 + band1.length * 4) + (1 + 2 + band2.length * 2);
    const v = new DataView(new ArrayBuffer(size));
    let o = 0;
    v.setUint8(o++, 1);                 // 小端
    v.setUint16(o, 0, true); o += 2;    // version
    v.setUint16(o, 2, true); o += 2;    // numBands
    v.setFloat64(o, 0.01, true); o += 8;
    v.setFloat64(o, -0.01, true); o += 8;
    v.setFloat64(o, 116.3, true); o += 8;
    v.setFloat64(o, 39.95, true); o += 8;
    v.setFloat64(o, 0, true); o += 8;   // skewX
    v.setFloat64(o, 0, true); o += 8;   // skewY
    v.setUint32(o, 4326, true); o += 4;
    v.setUint16(o, width, true); o += 2;
    v.setUint16(o, height, true); o += 2;
    v.setUint8(o++, 10 | 0x20);         // 32BF | hasNodata
    v.setFloat32(o, -9999, true); o += 4;
    for (const x of band1) { v.setFloat32(o, x, true); o += 4; }
    v.setUint8(o++, 5);                 // 16BSI，未置 hasNodata（仍写 2 字节 nodata 槽）
    v.setInt16(o, 0, true); o += 2;
    for (const x of band2) { v.setInt16(o, x, true); o += 2; }

    const bytes = new Uint8Array(v.buffer);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }
</script>

<main class="input-main" hidden={workbenchOpen}>
  <header class="input-hero">
    <h1>PostGIS Raster Viewer</h1>
    <p class="hint">粘贴或打开 PostGIS Raster WKB，在工作台中查看元数据、统计与渲染</p>
  </header>

  {#if sqlSupported}
    <div class="input-tabs" role="tablist">
      <button type="button" class="input-tab" role="tab" aria-selected={mode === "wkb"} onclick={() => (mode = "wkb")}>WKB 输入</button>
      <button type="button" class="input-tab" role="tab" aria-selected={mode === "sql"} onclick={() => (mode = "sql")}>SQL 查询</button>
    </div>
  {/if}

  {#if mode === "sql" && sqlSupported}
    <section class="input-card" aria-label="SQL 查询区">
      <div class="sql-row">
        <label class="sr-only" for="conn">数据库连接</label>
        <select id="conn" bind:value={connId}>
          {#if connections.length === 0}
            <option value="">无可用连接</option>
          {/if}
          {#each connections as c (c.id)}
            <option value={c.id} disabled={!c.connected}>
              {c.name}{c.connected ? "" : "（未连接）"}{c.database ? ` · ${c.database}` : ""}
            </option>
          {/each}
        </select>
      </div>
      <label class="sr-only" for="sql">SQL 语句</label>
      <textarea
        id="sql"
        rows="5"
        placeholder="SELECT rid, rast FROM raster_table WHERE ...&#10;结果经宿主通道取回（约 8MB 上限），可打开 result-view 无法承载的大栅格"
        bind:value={sqlText}
      ></textarea>
      <div class="actions">
        <button type="button" disabled={!connId || !sqlText.trim() || sqlRunning} onclick={() => void runSql()}>
          {sqlRunning ? "查询中…" : "执行查询"}
        </button>
      </div>
      <p class="hint">仅列出已连接的 PostgreSQL 连接；首次执行会请求该连接的数据访问授权。</p>
      <div class="input-feedback" aria-live="polite">
        {#if sqlError}
          <p class="error">{sqlError}</p>
        {/if}
      </div>
    </section>
  {:else}
  <section
    class="input-card"
    aria-label="WKB 输入区"
    aria-dropeffect="copy"
    class:dragover={dragover}
    ondragover={(e) => { e.preventDefault(); dragover = true; }}
    ondragleave={() => { dragover = false; }}
    ondrop={onDrop}
  >
    <label class="sr-only" for="hex">WKB 十六进制输入</label>
    <textarea
      id="hex"
      rows="5"
      placeholder="粘贴 ST_AsBinary(rast) 的十六进制（可含 \x 前缀、空白或换行），或拖入 / 打开文件"
      bind:value={hex}
    ></textarea>
    <div class="actions">
      <button type="button" disabled={!meta} onclick={openInWorkbench}>在工作台中打开</button>
      <button type="button" class="ghost" onclick={() => fileEl?.click()}>打开文件…</button>
      <button
        type="button"
        class="ghost"
        onclick={() => { hex = buildSampleHex(); }}
      >载入示例（8×6 双波段）</button>
      <input
        type="file"
        accept=".hex,.txt,.wkb,.bin"
        hidden
        bind:this={fileEl}
        onchange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }}
      />
    </div>
    <div class="input-feedback" aria-live="polite">
      {#if summary}
        <p class="input-ok">已识别：{summary}</p>
      {/if}
      {#if parseError}
        <p class="error">{parseError}</p>
      {/if}
      {#if workbenchError}
        <p class="error">{workbenchError}</p>
      {/if}
    </div>
  </section>
  {/if}
</main>

{#if workbenchOpen}
  <div class="input-wb-bar">
    <button type="button" class="ghost" onclick={closeWorkbench}>返回</button>
    <span class="hint">{wbSourceHint}</span>
  </div>
  <div class="input-wb-shell" bind:this={workbenchHost}></div>
{/if}
