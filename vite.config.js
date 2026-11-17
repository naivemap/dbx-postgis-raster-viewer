import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  // DBX 沙箱以静态文档加载 ui/，本地 preview.html 亦以相对路径内嵌 iframe
  base: "./",
  plugins: [
    svelte(),
    { name: "dbx-build-signal", closeBundle() { console.log("DBX_UI_BUILD_SUCCESS"); } },
  ],
  build: { outDir: "ui", emptyOutDir: true },
});
