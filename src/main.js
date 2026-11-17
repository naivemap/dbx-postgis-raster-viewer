/**
 * 入口：双模式引导。
 *
 * result-view 贡献点（或快照含结果行）→ 三栏工作台 Workbench；
 * 否则（workbench / 浏览器直开）→ 外部 WKB 输入页 InputPage
 * （粘贴/文件输入，经头部嗅探后直通同一套 Workbench）。
 * 两页各自动态 import，互不进入对方 bundle。
 *
 * 真实宿主沙箱里白屏无法排障：把未捕获异常兜底成页面内可见横幅 + 控制台堆栈。
 */
import "./app.css";
import { whenReady, contributionId } from "./lib/host.mjs";
import { mount } from "svelte";

const showBootError = (title, detail) => {
  console.error(`[raster-view] ${title}`, detail);
  let node = document.getElementById("boot-error");
  if (!node) {
    node = document.createElement("pre");
    node.id = "boot-error";
    node.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:12px;margin:0;padding:10px 12px;" +
      "z-index:9999;max-height:40vh;overflow:auto;background:#fdd;border:1px solid #c33;" +
      "color:#900;border-radius:6px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;";
    document.body.appendChild(node);
  }
  node.textContent = `${title}\n${detail ?? ""}`;
};
window.addEventListener("error", (event) =>
  showBootError("Script error", `${event.message}${event.filename ? `\n${event.filename}:${event.lineno}` : ""}`));
window.addEventListener("unhandledrejection", (event) =>
  showBootError("Unhandled rejection", event.reason?.stack ?? event.reason?.message ?? String(event.reason)));

const init = await whenReady();
const context = init?.context ?? init ?? null;

// 上下文形状与体量诊断：区分「宿主拒绝打开/截断快照」与「插件渲染异常」。
try {
  const result = context?.result;
  let payloadChars = 0;
  if (Array.isArray(result?.rows)) {
    for (const row of result.rows) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (typeof cell === "string") payloadChars += cell.length;
      }
    }
  }
  console.debug("[raster-view] boot:", {
    contribution: contributionId(),
    initKeys: init && typeof init === "object" ? Object.keys(init) : init,
    contextKeys: context && typeof context === "object" ? Object.keys(context) : context,
    columns: Array.isArray(result?.columns) ? result.columns.length : null,
    rows: Array.isArray(result?.rows) ? result.rows.length : null,
    truncated: result?.truncated ?? null,
    payloadChars,
  });
} catch {
  /* 诊断自身不能影响启动 */
}

const target = document.getElementById("app");
const isResultView =
  contributionId().endsWith(".view") || Array.isArray(context?.result?.rows);

if (isResultView) {
  const { default: Workbench } = await import("./Workbench.svelte");
  mount(Workbench, { target, props: { context } });
} else {
    const { default: InputPage } = await import("./InputPage.svelte");
    mount(InputPage, { target });
  }
