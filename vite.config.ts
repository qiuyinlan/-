import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // 相对路径部署：GitHub Pages 的任意仓库子路径（/<仓库名>/）都能直接跑，
  // 以后改仓库名也不用动配置（和「断舍离」一样的做法）。
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        id: "./",
        name: "回忆 · 个人背诵空间",
        short_name: "回忆",
        description: "导入讲义，自动生成挖空/问答卡，逐轮背诵与艾宾浩斯间隔复习。",
        lang: "zh-CN",
        theme_color: "#f5f7f4",
        background_color: "#f5f7f4",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "./icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // 应用外壳全部预缓存 —— 装到桌面之后断网也能打开。
        // 注意 /api/* 是本地转发服务（AI 制卡），永远走网络，不进缓存。
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
        // pdf 的 worker 是 ~1.4MB 的大文件，首屏用不到；首次用到时再缓存（见 runtimeCaching）
        globIgnores: ["**/pdf.worker*.mjs"],
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/\/api\//],
        runtimeCaching: [
          {
            urlPattern: /pdf\.worker.*\.mjs$/,
            handler: "CacheFirst",
            options: {
              cacheName: "pdf-worker",
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
});
