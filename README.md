# 回想

本地优先的个人背诵网站：导入讲义，自动生成挖空或问答卡，再选择逐轮背诵或艾宾浩斯间隔复习。

## 启动

```powershell
npm install
npm run build
npm start
```

然后打开 `http://127.0.0.1:4173`。`npm run dev` 只用于前端开发；AI 请求需要通过 `npm start` 提供的本地转发服务。

## 使用

- 支持 TXT、Markdown、PDF 和 DOCX 导入，也可以直接粘贴文本。
- “一键挖空”在本机按少/多密度生成，同一段的相邻句子会拼成一张卡，**最多 3 句、240 字**；AI 挖空同样按 2–3 句上下文出卡（`MAX_SENTENCES_PER_CARD`、`MAX_CARD_CHARS` 在 `src/lib/study.ts`）。
- AI 挖空和 AI 问答会把当前材料发送到设置的模型服务。
- 默认接入 DeepSeek API：Base URL `https://api.deepseek.com`，模型 `deepseek-flash`。也可按 DeepSeek 控制台可用模型修改，并填写自己的 API Key。
- 卡片与进度自动保存到 `data/study-data.json`，刷新和重启后仍保留；浏览器本地另有备份。API Key 只保存在当前浏览器会话。
- 可以连续添加多张手动问答卡，或在卡组管理中把新生成的卡片追加到现有卡组。
- **可选**：配置 Supabase 之后可以注册账号、登录，让两台设备（电脑 + 手机）的卡组与复习进度自动同步（见下一节）。不配置时完全照旧，只存本机。

## 账号与云端同步（可选）

云端方案照「断舍离」的做法来：**本地仍然是唯一真相源**，云端只是另一台设备的副本。

- 账号是 Supabase Auth 的**邮箱 + 密码**，不用自己写后端。
- 同步引擎照「断舍离」的 `src/cloud/sync.ts` 改造，纯合并逻辑在 `src/lib/cloudMerge.ts`：
  合并**只做加法**（两边新增的都保留），删除靠**墓碑**传播，冲突用乐观并发（`rev`），
  冲突时先合并再重试，不会静默覆盖；同一张卡片按较新的复习进度（`updatedAt`）为准。
- 首次在已有数据的账号上登录时会问一次「合并 / 本机覆盖 / 云端覆盖」。

配置步骤：

1. 在 https://supabase.com/ 建项目，拿到 Project URL 和 anon（Publishable）key；
2. SQL Editor 里跑一遍 `supabase/schema.sql`（建表 + RLS）；
3. Authentication → Providers → Email 确认开启；
4. 复制 `.env.example` 为 `.env`，填入两个变量；
5. `npm run build` 后重启 `npm start`，打开应用 → 右上角云朵图标（或侧边栏底部）→ 注册 / 登录。

详细步骤和常见问题见 `docs/supabase-接入步骤.md`。

## PWA（可安装到手机主屏幕）

构建产物自带 PWA 支持（`vite-plugin-pwa`）：Service Worker 预缓存整个应用外壳，
装到桌面后**全屏运行**（`display: standalone`），断网也能打开。

- 怎么装：在浏览器里打开应用（电脑上 `http://127.0.0.1:4173`，手机上建议用
  部署到 HTTPS 静态托管的地址）→ 地址栏出现「安装」按钮（安卓 Chrome），
  或分享菜单 →「添加到主屏幕」（iOS Safari）。
- 断网也能用：卡组和复习进度本来就存在浏览器 localStorage / 云端；
  只有 AI 制卡需要网络（走本地转发服务 `/api/generate`）。
- 手机上装 PWA 要用 **HTTPS 或 localhost**：`http://局域网IP` 不是安全上下文，
  Service Worker 不会注册（页面本身仍能打开，但装不了、也没有离线缓存）。
- 重新生成图标：`npm run icons`（生成 `public/icon-192.png`、`icon-512.png`、`favicon.svg`）。

## 部署到 GitHub Pages

本应用是独立的静态前端，建议单独建一个仓库再发布（构建走相对路径，任意仓库名都能跑）：

1. 在 GitHub 建一个空仓库（public；免费版 Pages 只支持公开仓库）；
2. 把这个目录推上去：`git init` → `git add .` → `git commit` → `git remote add origin <仓库地址>` → `git push -u origin main`；
3. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**（推送后自动部署，见 `.github/workflows/deploy.yml`）；
4. 线上地址形如 `https://<你的用户名>.github.io/<仓库名>/`。

- 想在线上开云端同步：在仓库 **Settings → Secrets and variables → Actions** 加两个
  Secrets（`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`），然后再推一次（或手动
  Re-run 部署），让构建带上它们——Vite 只在构建时读这两个值。
- 线上没有本机的 `/api/data` 和 `/api/generate`：卡组存在浏览器 localStorage（刷新、
  关页面都不丢），登录后同步到 Supabase；**AI 制卡需要本地转发服务**，线上用不了，
  其余功能不受影响。
- 本机数据（`data/`，卡组和备份）已被 gitignore，不会上传到仓库。

## AI 生成：进度、重试与长文本

材料会长文本会被切成约 3000 字一段，两段并发生成，页面显示进度条、已用时间和已生成张数，可随时点“停止”（同时取消上游请求，不白花钱）。

- 单段失败会自动重试最多 3 次（超时、断流、429/5xx 都算可重试）。
- 模型输出被 `max_tokens` 截断时，服务端先把截断点之前完整的卡片抢救回来；一张都救不回来才返回“太长”，由前端把这段再对半拆小重试，最短拆到 1000 字。
- 某一段彻底失败不会中断整轮：其余段继续生成，结束后提示哪几段没有成功，已生成的卡片保留在页面上。
- 推理型模型（如 `deepseek-v4-pro`）会先花大量 token 思考，默认把单段输出上限放宽到 16384；可用环境变量 `HUIXIANG_MAX_TOKENS` 覆盖。

## AI 制卡的 token 都花在哪

实测（deepseek-flash，3000 字材料、12 张卡）：一次约 1 万 token，其中

| 部分 | 占比 | 说明 |
|---|---|---|
| reasoning（思考） | 60–85% | 模型先「想」怎么筛知识点、怎么摆空位，这部分按输出 token 计费 |
| 卡片正文 | ~12% | 每张卡把 2–3 句原文放进 front，所以输出约为材料的 40% |
| 提示词 | ~18% | 指令 + 材料本身；指令前缀命中服务商缓存后按 1/10 计价 |

结论：**思考和卡片数量是大头**。已验证过把 reasoning 关掉：token 降到 1/5、速度快 5 倍，但挖空格式直接崩（`{{c1::}}` 不出现在 front，20 张里 0 张可用），所以没有关。

已经做的优化：
- **结果缓存**：同样的材料 + 同样的设置再点一次，直接复用上次结果，0 token、秒回（服务端内存缓存 1 小时，最多 200 条）。
- **默认模型提醒**：`deepseek-v4-pro` 的思考 token 约是 `deepseek-flash` 的 2–3 倍、速度慢一倍以上，设置弹窗里有提示。
- **Token 透明**：进度条实时显示 `已用 N tokens`，结束时提示本次消耗和命中缓存的段数。
- **成本旋钮**：`HUIXIANG_CARDS_PER_SEGMENT=6` 把每段卡片数从 12 降到 6，token 大约省一半、速度也快一倍（覆盖度同样减半）。

## 把老卡组合并成 3 句卡

之前的卡组是「一句一张」。`src/lib/study.ts` 里的 `mergeIntoContextCards(cards, 3)` 会把同一小节里相邻的挖空卡拼成最多 3 句一张的卡：空位全部保留并重新编号，复习状态取最早的一次，问答卡不参与合并。

```powershell
# 先试跑（不改文件），确认统计没问题再正式跑
$env:DRY='1'; npx tsc src/lib/study.ts --outDir ../tmp/migrate --module esnext --target es2022 --moduleResolution bundler --skipLibCheck; node ../tmp/migrate-deck.mjs
Remove-Item Env:DRY; node ../tmp/migrate-deck.mjs
```

正式跑前会把原数据备份到 `data/study-data.backup-<时间>.json`，想回退就把备份拷回去、刷新页面。

交互借鉴 Anki 的挖空与间隔重复思路，以及 SparkPilot 的材料导入和 AI 制卡流程；该项目是独立实现。接口参数见 [DeepSeek API 文档](https://api-docs.deepseek.com/)。
