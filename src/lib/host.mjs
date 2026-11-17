/**
 * DBX 宿主桥（window.dbxPlugin）的防御式封装。
 *
 * result-view 与 workbench 共用 ui/index.html 入口，宿主注入的桥可能不存在
 * （浏览器直接打开 / 静态服务器调试）、可能是旧版 Host API、用户也可能随时
 * 撤销数据授权——所有访问都必须降级而非崩溃。
 */

const PLUGIN_DATA_ACCESS_NOT_GRANTED = "PLUGIN_DATA_ACCESS_NOT_GRANTED";

/**
 * 定位宿主桥；无宿主环境返回 undefined。
 *
 * 真实宿主向沙箱文档注入 window.dbxPlugin；本地预览宿主（tools/preview.html）
 * 无法跨导航注入，把同形对象挂在 window.parent.__dbxBridge 上供回退。
 * 回退仅用于开发；生产环境的 parent 是 DBX shell，没有该属性，无害。
 */
export function host() {
  if (typeof window === "undefined") return undefined;
  if (window.dbxPlugin) return window.dbxPlugin;
  try {
    return window.parent?.__dbxBridge ?? undefined;
  } catch {
    // 跨域 parent：无可借用
    return undefined;
  }
}

/** 宿主握手完成后 resolve，返回初始上下文（含 result / connectionId / sql）；无宿主返回 null。 */
export async function whenReady() {
  const api = host();
  if (!api) return null;
  try {
    return (await api.ready) ?? null;
  } catch {
    return null;
  }
}

/**
 * 订阅宿主上下文重新推送（结果集 re-run 时宿主会重推）。
 * 返回取消订阅函数。
 */
export function onContext(handler) {
  const api = host();
  if (api && typeof api.onContext === "function") {
    try {
      return api.onContext(handler) || (() => {});
    } catch {
      /* 落到事件监听 */
    }
  }
  const listener = (event) => handler(event?.detail ?? null);
  window.addEventListener("dbx-plugin-context", listener);
  return () => window.removeEventListener("dbx-plugin-context", listener);
}

/** 当前激活的贡献点 id（区分 result-view 与 workbench 场景）。 */
export function contributionId() {
  return host()?.contributionId ?? "";
}

export function locale() {
  return host()?.locale ?? "en";
}

export function isZh() {
  return String(locale()).toLowerCase().startsWith("zh");
}

/** 能力位是权威来源；缺位即视为不支持。 */
export function capabilities() {
  return host()?.capabilities ?? {};
}

export function canQueryData() {
  return capabilities().dataApi === true;
}

/** 数据访问失败（含用户未授权 / 已撤销授权）。needsGrant 时 UI 引导重新授权。 */
export class DataAccessError extends Error {
  constructor(message, { needsGrant = false } = {}) {
    super(message);
    this.name = "DataAccessError";
    this.needsGrant = needsGrant;
  }
}

/**
 * 经宿主执行一条只读语句（Host API 1.4，权限 host.data:read）。
 * 首次调用会触发宿主授权弹窗；被拒绝时以 PLUGIN_DATA_ACCESS_NOT_GRANTED 抛出。
 *
 * @param {{connectionId: string, database?: string, schema?: string, sql: string,
 *   maxRows?: number, timeoutMs?: number}} request
 * @returns {Promise<{columns: Array, rows: unknown[][], truncated?: boolean, elapsedMs?: number}>}
 */
export async function queryData(request) {
  const api = host();
  if (!api || typeof api.request !== "function") {
    throw new DataAccessError("宿主 API 不可用");
  }
  if (!canQueryData()) {
    throw new DataAccessError("当前 DBX 版本不支持 host.queryData（需要 Host API 1.4）");
  }
  const payload = {
    connectionId: request.connectionId,
    sql: request.sql,
    // 宿主硬上限：5000 行 / 60s / 100k SQL 字符
    maxRows: Math.min(5000, Math.max(1, request.maxRows ?? 200)),
    timeoutMs: Math.min(60_000, Math.max(1000, request.timeoutMs ?? 30_000)),
  };
  if (request.database) payload.database = request.database;
  if (request.schema) payload.schema = request.schema;

  try {
    return await api.request("host.queryData", payload);
  } catch (error) {
    const message = error?.message || String(error);
    throw new DataAccessError(message, {
      needsGrant: message.includes(PLUGIN_DATA_ACCESS_NOT_GRANTED),
    });
  }
}

/**
 * 列出宿主连接（需 host.connections:read 权限；无宿主 / 失败返回空数组）。
 * 条目形状：{ id, name, dbType, connected, database, schema }。
 */
export async function listConnections() {
  const api = host();
  if (!api || typeof api.request !== "function") return [];
  try {
    const list = await api.request("host.listConnections", {});
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
