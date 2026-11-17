# PostGIS Raster Viewer

面向 PostGIS 的栅格结果视图插件：客户端解码 WKB，提供影像渲染、像元值表格与分波段统计。

完整的[插件开发指南](https://dbxio.com/cn/docs/plugin-development)（manifest 字段、Host API、调试、打包与市场发布）见官方文档。

## 使用

插件提供两个入口：

- **栅格视图（result-view）**：查询返回 PostGIS raster 时，在结果集切换到"栅格视图"，客户端解码 WKB，提供影像渲染、像元值表格与分波段统计。
- **工作台（workbench）**：打开 "PostGIS Raster Viewer" 工作台，可粘贴或从文件载入外部栅格 WKB 数据，进行完整渲染与统计分析。

## 开发

UI 采用 Svelte 5 编写，位于 `src/`，由 Vite 构建输出到 `ui/`。核心逻辑保持框架无关，位于 `src/lib/`（Node 自测亦直接引用）。安装依赖后，使用 Node.js 22+ 运行浏览器开发宿主：

```bash
pnpm install
dbx-plugin dev --path . --port 5190   # 使用 dbx-plugin.toml 中 [dev] 的 ui_build
```

迭代开发时可在第二个终端保持监听构建，每次重建后开发宿主会自动刷新页面：

```bash
pnpm run build:watch
```

无需后端或 DBX 应用。从开发外壳打开本插件的工作台即可；最终集成测试请使用真实 DBX 宿主。`ui/` 为构建产物，不要编辑或提交；`.dbx-dev/` 存储本地开发数据，禁止提交或打包。

## 测试

运行框架无关的单元测试（无需额外安装，仅依赖 Node）：

```bash
pnpm test
```

## 打包

打包插件（通过 `dbx-plugin.toml` 会先执行 `pnpm run build`）：

```bash
dbx-plugin package . --target universal
```

该命令会暂存 `manifest.json`、`assets/` 与 `ui/`，然后在 `dist/` 中写入未签名的 universal `.dbxp` 候选包及配套 `.artifact.json`。
