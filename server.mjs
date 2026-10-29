import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, parseCards, salvageCards } from "./server/cards.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "study-data.json");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json; charset=utf-8", ".ico": "image/x-icon" };

// 同样的材料 + 同样的设置再点一次，直接复用上次结果，不重复烧 token。
const cardCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 200;

function cacheKey({ model, kind, density, text }) {
  return crypto.createHash("sha256").update(JSON.stringify([model, kind, density, text])).digest("hex");
}

function readCached(key) {
  const hit = cardCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cardCache.delete(key); return null; }
  return hit.payload;
}

function writeCached(key, payload) {
  if (cardCache.size >= CACHE_LIMIT) cardCache.delete(cardCache.keys().next().value);
  cardCache.set(key, { at: Date.now(), payload });
}

function usageOf(usage) {
  if (!usage) return { prompt: 0, completion: 0, reasoning: 0, total: 0, cached: false };
  const completion = usage.completion_tokens ?? 0;
  return {
    prompt: usage.prompt_tokens ?? 0,
    completion,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    total: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + completion),
    cached: false,
  };
}

function send(res, status, body) {
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000_000) throw Object.assign(new Error("请求数据过大。"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求内容格式无效。"), { status: 400 }); }
}

async function readAppData() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dataFile, "utf8"));
    return { decks: Array.isArray(parsed.decks) ? parsed.decks : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { decks: [] };
    throw error;
  }
}

async function saveAppData(req, res) {
  let input;
  try { input = await readJson(req); }
  catch (error) { return send(res, error.status || 400, { error: error.message }); }
  if (!Array.isArray(input.decks)) return send(res, 400, { error: "卡组数据格式无效。" });
  if (input.decks.length > 500) return send(res, 413, { error: "卡组数量超出限制。" });
  await fs.promises.mkdir(dataDir, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await fs.promises.writeFile(temporaryFile, `${JSON.stringify({ decks: input.decks }, null, 2)}\n`, "utf8");
  await fs.promises.rename(temporaryFile, dataFile);
  return send(res, 200, { ok: true });
}

async function generate(req, res) {
  const origin = req.headers.origin;
  const expectedOrigin = `http://${req.headers.host}`;
  if (origin && origin !== expectedOrigin) return send(res, 403, { error: "请求来源校验失败。" });

  let input;
  try { input = await readJson(req); }
  catch (error) { return send(res, error.status || 400, { error: error.message }); }

  const { baseUrl, apiKey, model, kind, density, text } = input;
  if (typeof apiKey !== "string" || !apiKey.trim()) return send(res, 400, { error: "请先填写 API Key。" });
  if (typeof model !== "string" || !model.trim()) return send(res, 400, { error: "请填写服务商提供的模型 ID。" });
  if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "没有可生成的材料。" });

  let endpoint;
  try {
    const base = new URL(String(baseUrl || ""));
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
    endpoint = `${base.toString().replace(/\/$/, "")}/chat/completions`;
  } catch {
    return send(res, 400, { error: "API Base URL 必须是有效的 HTTPS 地址，例如 https://api.deepseek.com。" });
  }

  const prompt = buildPrompt({ kind, density, text });
  // 推理型模型（deepseek-v4-pro 等）会先消耗大量 reasoning tokens，输出预算给小了会被截断成 JSON 半截。
  const maxTokens = Number(process.env.HUIXIANG_MAX_TOKENS) || 16_384;

  const key = cacheKey({ model: model.trim(), kind, density, text });
  const cached = readCached(key);
  if (cached) return send(res, 200, { ...cached, usage: { prompt: 0, completion: 0, reasoning: 0, total: 0, cached: true } });

  // 浏览器主动中止（用户点“停止”）时，同时取消上游请求，避免白花钱。
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", onClose);

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      // 用流式请求：推理型模型的非流式请求容易被服务商或中间代理按空闲连接掐断。
      // include_usage 让它把真实 token 消耗放在最后一个数据块里，界面才能显示花了多少。
      body: JSON.stringify({ model: model.trim(), messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_object" }, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]),
      redirect: "error",
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error?.name === "TimeoutError"
      ? "模型请求超过 4 分钟没有返回，请检查网络后重试。"
      : "无法连接 API 地址，请检查网络和 Base URL。";
    return send(res, 502, { error: message, code: "upstream" });
  }

  if (!upstream.ok) {
    let raw = "";
    try { raw = await upstream.text(); } catch { /* 上游错误页读不出来时用状态码兜底 */ }
    let detail = raw.slice(0, 600);
    try { detail = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || detail; } catch {}
    return send(res, upstream.status, { error: `模型接口返回 ${upstream.status}：${detail}`, code: "upstream" });
  }

  const read = await readCompletion(upstream);
  const usage = usageOf(read.usage);
  if (read.error) {
    if (controller.signal.aborted || res.destroyed) return;
    // 断流前已经流出来的完整卡片不浪费。
    const partial = salvageCards(read.content);
    if (partial.length) return send(res, 200, { cards: partial, truncated: true, usage });
    const message = read.error?.name === "TimeoutError"
      ? "模型请求超过 4 分钟没有返回，请检查网络后重试。"
      : "和模型的连接中途断开了（服务商断流或网络抖动）。";
    return send(res, 502, { error: message, code: "upstream", usage });
  }

  const content = read.content;
  const finishReason = read.finishReason;
  if (typeof content !== "string" || !content.trim()) {
    return send(res, 502, { error: "接口没有返回文本内容，请检查所选模型是否支持 Chat Completions。", code: "upstream" });
  }

  try {
    const cards = parseCards(content);
    if (!cards.length) throw new Error("模型没有生成有效卡片，请再试一次。");
    const truncated = finishReason === "length";
    if (!truncated) writeCached(key, { cards, truncated });
    return send(res, 200, { cards, truncated, usage });
  } catch (error) {
    // 输出被截断 / JSON 半截：把截断点之前的完整卡片抢救出来，剩下的交给前端拆小重试。
    const salvaged = salvageCards(content);
    if (salvaged.length) return send(res, 200, { cards: salvaged, truncated: true, usage });
    if (finishReason === "length") {
      return send(res, 502, { error: "本段材料太长，模型输出被截断。会自动拆段重试。", code: "too_long", usage });
    }
    return send(res, 502, { error: error.message || "解析模型返回结果失败。", code: "incomplete", usage });
  }
}

// 读 SSE 增量（也兼容服务商忽略 stream 字段、直接返回整包 JSON 的情况）。
// 出错时不抛异常，而是把断流前累积到的内容一起返回。
async function readCompletion(upstream) {
  const type = upstream.headers.get("content-type") || "";
  if (!type.includes("event-stream")) {
    let raw;
    try { raw = await upstream.text(); }
    catch (error) { return { content: "", finishReason: undefined, usage: undefined, error }; }
    try {
      const response = JSON.parse(raw);
      return { content: response.choices?.[0]?.message?.content ?? "", finishReason: response.choices?.[0]?.finish_reason, usage: response.usage };
    } catch (error) {
      return { content: "", finishReason: undefined, usage: undefined, error };
    }
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let finishReason;
  let usage;
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (typeof choice?.delta?.content === "string") content += choice.delta.content;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch { /* 忽略心跳等非 JSON 行 */ }
      }
    }
  } catch (error) {
    return { content, finishReason, usage, error };
  }
  return { content, finishReason, usage };
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/data" && req.method === "GET") {
    try { return send(res, 200, await readAppData()); }
    catch { return send(res, 500, { error: "读取本地学习数据失败。" }); }
  }
  if (url.pathname === "/api/data" && req.method === "PUT") {
    const origin = req.headers.origin;
    const expectedOrigin = `http://${req.headers.host}`;
    if (origin && origin !== expectedOrigin) return send(res, 403, { error: "请求来源校验失败。" });
    try { return await saveAppData(req, res); }
    catch { return send(res, 500, { error: "写入本地学习数据失败，请检查磁盘空间和目录权限。" }); }
  }
  if (url.pathname === "/api/generate" && req.method === "POST") {
    await generate(req, res);
    return;
  }
  if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "未知 API 路径。" });

  const pathname = decodeURIComponent(url.pathname);
  let file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${dist}${path.sep}`) && file !== path.join(dist, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
  if (!fs.existsSync(file)) return res.writeHead(404).end("Build the app first with npm run build.");
  res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    console.error("请求处理失败:", error);
    send(res, 500, { error: "本地服务处理请求失败，请重试。" });
  }
});

// 客户端提前断开（关页面、点停止）不应该拖垮进程。
server.on("clientError", (_error, socket) => { socket.destroy(); });

const port = Number(process.env.PORT) || 4173;
server.listen(port, "127.0.0.1", () => console.log(`回想学习空间已启动：http://127.0.0.1:${port}`));
