# com.naivemap.dbx-postgis-raster-viewer

## 0.2.0 (2026-10-26)

- 新增 SQL 查询模式，绕开 result-view 2MB 快照限制，取数上限约 8MB
- 移除 RGB 合成渲染，渲染模型收敛为单波段
- 像元值表小数位可配置，默认 1 位小数
- 波段统计表优化展示

## 0.1.0 (2026-10-23)

- 初始版本，支持 PostGIS Raster 数据可视化
