/**
 * 云端同步引擎（Supabase）—— 账号登录 + 多设备同步。
 *
 * 照「断舍离」的 src/cloud/sync.ts / client.ts 改造而来，做法一致：
 *
 * ── 一句话说清它是怎么工作的 ─────────────────────────────────────
 * **本地数据（浏览器 localStorage + 本机文件）仍然是唯一真相源**，
 * 云端只是「另一台设备的副本」。每次同步：拉远端 → 和本地合并
 * （cloudMerge.ts）→ 落回本地 → 再把结果推上去。
 * 没配 Supabase、没登录的时候，同步这一层完全不动，应用和以前一模一样。
 *
 * ── 为什么不让「云端直接当存储」 ─────────────────────────────────
 * 整份覆盖的话，两台设备就会「谁后写谁赢」——手机上刚录的会被电脑上
 * 那份整份盖掉，而且是静默的。要不出这种事就必须有「合并」，而合并只能
 * 在**两份数据**之间做，所以引擎必须能同时拿到本地和远端两份。
 * 另外断网时应用照样要能打开 —— 所以同步只做「合并 + 备份」，不抢
 * 本地的默认存储位置。
 *
 * ── 什么时候同步 ─────────────────────────────────────────────────
 *   · 启动后（本地数据读出来了）
 *   · 每次本地改动之后（防抖，见 PUSH_DELAY_MS）
 *   · 切回前台 / 窗口重新获得焦点 / 网络恢复（都限流，见 MIN_INTERVAL_MS）
 *   · 用户点「立即同步」
 * 刻意**不做实时推送**（Realtime）：两台设备同时改同一份数据的情况很少，
 * 多一条长连接就多一类「半夜断了没人知道」的故障。
 *
 * ── 配置从哪来 ───────────────────────────────────────────────────
 * 两个环境变量（Vite 只把 VITE_ 开头的暴露给前端，构建时定下来）：
 *   VITE_SUPABASE_URL       形如 https://abcdefg.supabase.co
 *   VITE_SUPABASE_ANON_KEY  浏览器用的那把公开钥匙（anon / Publishable）
 * ⚠️ Secret key / service_role 绝不能进前端 —— 那是能绕过访问规则的全库钥匙。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Deck } from "./study";
import {
  ENVELOPE_VERSION,
  SCHEMA_VERSION,
  type CloudEnvelope,
  type DeckTombstones,
  checkEnvelope,
  collectDeckRemovals,
  emptyTombstones,
  hasAnyCards,
  makeEnvelope,
  mergeEnvelopes,
  mergeTombstones,
  sameEnvelopeContent,
} from "./cloudMerge";

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 云端那张表的名字（建表脚本在 supabase/schema.sql） */
export const CLOUD_TABLE = "app_data";

export interface CloudConfig {
  url: string;
  anonKey: string;
}

/**
 * 配置为什么用不了。
 *
 * 分这么细是因为「没配云端」这一句话不够用：拿错钥匙的人需要的是
 * 「你拿的是 Secret key，而且它必须马上删掉重发一把」，
 * 而不是一句「还没配云端」让他继续去翻别处。
 */
export type CloudConfigProblem = "missing" | "placeholder" | "secretKey";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 这把钥匙是不是「能绕过安全规则」的那种。
 *
 * 两种都要认出来：
 *   · 新的 Secret key：`sb_secret_...`
 *   · 老的 service_role：一段 JWT，载荷里写着 `"role": "service_role"`
 * 老格式现在控制台里还有（也能继续用），所以不能只看前缀。
 */
export function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const payload = decodeJwtPayload(key);
  return payload !== null && payload.role === "service_role";
}

function looksLikePlaceholder(value: string): boolean {
  return /x{6,}/i.test(value) || value.includes("your-project");
}

/**
 * 判断一组环境变量能不能用。抽成**纯函数**（而不是直接读 import.meta.env）
 * 是为了能测：环境变量是构建时定下来的，测试里改不了 import.meta.env。
 */
export function evaluateConfig(env: Record<string, string | undefined>): {
  config: CloudConfig | null;
  problem: CloudConfigProblem | null;
} {
  const url = (env.VITE_SUPABASE_URL ?? "").trim();
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();

  if (url === "" || anonKey === "") return { config: null, problem: "missing" };

  // 危险钥匙**优先**判断：拿错的人必须看得到这一条
  if (isSecretKey(url) || isSecretKey(anonKey)) return { config: null, problem: "secretKey" };

  // 还是 .env.example 里那份模板，照着填了一遍
  if (looksLikePlaceholder(url) || looksLikePlaceholder(anonKey)) {
    return { config: null, problem: "placeholder" };
  }

  return { config: { url, anonKey }, problem: null };
}

function readEnv(): Record<string, string | undefined> {
  // 测试环境（Node 里跑）没有 import.meta.env，用可选链兜住
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env ?? {};
}

const readConfig = evaluateConfig(readEnv());

export const cloudConfig: CloudConfig | null = readConfig.config;
export const cloudConfigProblem: CloudConfigProblem | null = readConfig.problem;

export function isCloudConfigured(): boolean {
  return cloudConfig !== null;
}

let client: SupabaseClient | null = null;

/**
 * 懒创建。没配置时返回 null —— 调用方每一步开头都先问这一句，
 * 于是「没配云端」的路径上不会有人去碰 SDK。
 *
 * 这里刻意**不用** SDK 自带的本机会话存储改造：它默认把会话存在
 * localStorage（键名 sb-<ref>-auth-token），刷新页面不用重新登录，
 * 而 localStorage 按网址隔离，所以 localhost 和线上部署是两条独立的
 * 登录状态（跟数据一样）。
 */
export function getClient(): SupabaseClient | null {
  if (cloudConfig === null) return null;
  if (client === null) {
    client = createClient(cloudConfig.url, cloudConfig.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // 只做邮箱 + 密码，不需要解析地址栏里的回调参数
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export type SyncPhase = "off" | "idle" | "syncing" | "error" | "outdated";

export interface FirstSyncChoice {
  localDecks: number;
  remoteDecks: number;
  remoteAt: string;
}

export interface CloudState {
  /** 环境变量配了没有 */
  configured: boolean;
  /** 这个浏览器上登录了没有 */
  signedIn: boolean;
  email: string | null;
  phase: SyncPhase;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 本地有改动还没推上去 */
  pending: boolean;
  /** 首次绑定、两边都有卡片 —— 等用户选一次用哪边 */
  choice: FirstSyncChoice | null;
}

/**
 * ⚠️ 每次变化都换一个新对象。
 *
 * React 的 useSyncExternalStore 会拿两次快照做 Object.is 比较：
 * 每次返回新对象 = 永远判定「变了」= 无限重渲染。所以这里是**换引用**。
 */
let state: CloudState = {
  configured: isCloudConfigured(),
  signedIn: false,
  email: null,
  phase: "off",
  lastSyncAt: null,
  lastError: null,
  pending: false,
  choice: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<CloudState>): void {
  const next = { ...state, ...patch };
  if (
    next.configured === state.configured &&
    next.signedIn === state.signedIn &&
    next.email === state.email &&
    next.phase === state.phase &&
    next.lastSyncAt === state.lastSyncAt &&
    next.lastError === state.lastError &&
    next.pending === state.pending &&
    next.choice === state.choice
  ) {
    return;
  }
  state = next;
  for (const fn of [...listeners]) fn();
}

export function getCloudState(): CloudState {
  return state;
}

export function subscribeCloud(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* ------------------------------------------------------------------ */
/* 本机标识与墓碑的持久化                                              */
/* ------------------------------------------------------------------ */

const DEVICE_KEY = "huixiang:cloud-device";

/**
 * 这台设备的标识。
 *
 * 用途只有一个：判断「远端那份是不是我自己刚推上去的」，避免同一份数据
 * 来回推、来回合并。放在 localStorage 里 —— 它属于**这台设备**，
 * 不属于数据本身，所以不能混进 decks（那会被导出、被同步）。
 */
function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // 无痕模式：拿不到就当这次的设备是个临时设备，同步照样能用
    return "ephemeral";
  }
}

const device = deviceId();

/**
 * 墓碑按**账号**分开放。
 *
 * 不能共用一个键：换账号登录时，上一个账号的删除墓碑会跟着过来，
 * 把新账号里 id 恰好相同的记录按掉（id 是 uuid，概率极低，但这不是
 * 「概率低就可以不做」的那类问题 —— 代价是不可恢复的删数据）。
 */
function tombstoneKey(userId: string): string {
  return `huixiang:cloud-tombstones:${userId}`;
}

function boundKey(userId: string): string {
  return `huixiang:cloud-bound:${userId}`;
}

function loadTombstones(userId: string): DeckTombstones {
  try {
    const raw = JSON.parse(localStorage.getItem(tombstoneKey(userId)) || "null") as Partial<DeckTombstones> | null;
    if (!raw || typeof raw !== "object") return emptyTombstones();
    const out = emptyTombstones();
    for (const [id, at] of Object.entries(raw.decks ?? {})) {
      if (typeof at === "number") out.decks[id] = at;
    }
    for (const [id, at] of Object.entries(raw.cards ?? {})) {
      if (typeof at === "number") out.cards[id] = at;
    }
    return out;
  } catch {
    return emptyTombstones();
  }
}

function saveTombstones(userId: string, tombstones: DeckTombstones): void {
  try {
    localStorage.setItem(tombstoneKey(userId), JSON.stringify(tombstones));
  } catch {
    // 无痕模式写不进去也不影响这一次同步，下次会重新合并
  }
}

function isBound(userId: string): boolean {
  try {
    return localStorage.getItem(boundKey(userId)) === "1";
  } catch {
    return false;
  }
}

function markBound(userId: string): void {
  try {
    localStorage.setItem(boundKey(userId), "1");
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* 与界面的绑定（应用层把「读卡组 / 落卡组 / 提示」三个口子接进来）      */
/* ------------------------------------------------------------------ */

export interface CloudBindings {
  getDecks(): Deck[];
  applyDecks(decks: Deck[]): void;
  notify(message: string): void;
}

let bindings: CloudBindings | null = null;
let ready = false;

/** 应用启动时调用一次：把读写本地数据的口子交给引擎，并开始监听 */
export function bindCloud(next: CloudBindings): void {
  bindings = next;
  if (started) return;
  started = true;

  if (!isCloudConfigured()) {
    setState({ configured: false, phase: "off" });
    return;
  }

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void syncNow("online"));
    window.addEventListener("focus", () => void syncNow("visible"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void syncNow("visible");
    });
  }

  const supabase = getClient();
  supabase?.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      transport = null;
      setState({ signedIn: false, email: null, phase: "off", choice: null });
    }
    /*
     * 会话续期（TOKEN_REFRESHED）也会走到这里，但**不在这里触发同步**：
     * 它可能在任何时刻发生，跟着它同步会让网络请求变得不可预测。
     * 需要同步的地方（登录后、改动后、切前台）都已经各自触发了。
     */
  });

  void ensureTransport()
    .then((active) => {
      if (active && ready) void syncNow("start");
    })
    .catch(() => {
      // 拿会话失败不是致命错误：没登录就等于没开同步，界面上会说明
    });
}

/** 本地数据读出来之后调用一次 —— 引擎这时才允许真正开始同步 */
export function cloudMarkReady(): void {
  ready = true;
  if (bindings !== null && transport !== null) void syncNow("start");
}

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

/** 本地改完之后等这么久再推 —— 连续录入时不会每敲一下都发一次请求 */
const PUSH_DELAY_MS = 2500;

/** 焦点 / 切前台 / 联网这类触发的最小间隔，免得来回切窗口就疯狂同步 */
const MIN_INTERVAL_MS = 20_000;

/** 版本冲突时最多重试几轮（每轮都会先合并再推） */
const MAX_CONFLICT_RETRIES = 3;

/** 内部信号：连着冲突太多次，这一轮先放弃（不是错误） */
const CONFLICT_PENDING = "SYNC_CONFLICT_PENDING";

/** 内部信号：远端数据比本程序新（信封或数据结构版本更高） */
const OUTDATED = "SYNC_OUTDATED_VERSION";

/* ------------------------------------------------------------------ */
/* 运行时状态                                                          */
/* ------------------------------------------------------------------ */

let tombstones: DeckTombstones = emptyTombstones();
let lastSyncMs = 0;
let started = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let pendingChoice: { envelope: CloudEnvelope; rev: number } | null = null;
let lastFailureDetail: string | null = null;

/** 上一次同步失败的原始报错（界面上「技术细节」展开的就是它） */
export function cloudFailureDetail(): string | null {
  return lastFailureDetail;
}

/** 当前本机设备号（界面上要显示，方便用户分辨「这台是哪台」） */
export function currentDeviceId(): string {
  return device;
}

/* ------------------------------------------------------------------ */
/* 错误翻译                                                            */
/* ------------------------------------------------------------------ */

function networkMessage(): string {
  const host = cloudConfig?.url ?? "https://<project-ref>.supabase.co";
  return `连不上云端的地址（${host}）。先用浏览器直接打开这个域名试试——常见原因是网络断了、代理或安全软件拦了请求，也可能是项目地址写错了。`;
}

function looksLikeNetwork(lower: string): boolean {
  return (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed") ||
    lower.includes("timeout") ||
    lower.includes("offline")
  );
}

/**
 * 把 Supabase / 网络的报错翻成一句人话。原文保留在 lastFailureDetail，
 * 界面上能展开看 —— 「密码错了」和「项目还没建表」糊成一句「同步失败」
 * 的话，就只能靠猜。
 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  lastFailureDetail = raw;
  const lower = raw.toLowerCase();

  if (looksLikeNetwork(lower)) return networkMessage();

  if (lower.includes("relation") && lower.includes("does not exist")) return noTableMessage();
  if (raw.includes("42P01") || raw.includes("PGRST205")) return noTableMessage();
  if (lower.includes("does not exist") && lower.includes("column")) return noTableMessage();
  if (lower.includes("invalid api key") || lower.includes("api key")) {
    return `Supabase 不认这个钥匙（${raw}）。检查 .env 里 VITE_SUPABASE_ANON_KEY 是不是项目的 anon / Publishable key，改完重新 npm run build。`;
  }

  return `同步失败：${raw}`;
}

function noTableMessage(): string {
  return "云端还没有建表（或者访问规则没生效）。去 Supabase 控制台 → SQL Editor，把 supabase/schema.sql 整段粘进去 Run 一次。";
}

function describeAuthError(raw: string): string {
  lastFailureDetail = raw;
  const lower = raw.toLowerCase();
  if (looksLikeNetwork(lower)) return networkMessage();
  if (lower.includes("invalid login credentials")) return "邮箱或密码不对。";
  if (lower.includes("email not confirmed")) return "邮箱还没确认，先去邮箱点一下确认链接再来登录。";
  if (lower.includes("already registered") || lower.includes("already been registered")) {
    return "这个邮箱已经注册过了，直接登录即可（或去邮箱确认后登录）。";
  }
  if (lower.includes("password should be at least") || lower.includes("password is too short")) {
    return "密码太短了，Supabase 默认至少 6 位。";
  }
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "请求太频繁被限流了，等一分钟再试。";
  }
  if (lower.includes("signups not allowed") || lower.includes("signup is disabled")) {
    return "这个项目关闭了注册。去 Supabase 控制台 → Authentication → Providers → Email 里把注册打开。";
  }
  if (lower.includes("unable to validate email") || lower.includes("invalid email")) {
    return "邮箱格式不对。";
  }
  return `登录失败：${raw}`;
}

/* ------------------------------------------------------------------ */
/* 真实传输层                                                          */
/* ------------------------------------------------------------------ */

export interface PulledRemote {
  envelope: CloudEnvelope | null;
  rev: number;
}

export interface CloudTransport {
  userId: string;
  email: string;
  pull(): Promise<PulledRemote>;
  /** 成功 → 返回新的 rev；null → 版本冲突（期间别的设备写过了） */
  push(envelope: CloudEnvelope, baseRev: number): Promise<number | null>;
}

let transport: CloudTransport | null = null;

function looksLikeMissingTable(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (message.includes("does not exist") && message.includes("relation"))
  );
}

function makeSupabaseTransport(): CloudTransport | null {
  const supabase = getClient();
  if (!supabase) return null;

  // userId / email 由 ensureTransport() 填好之后才用
  const found: CloudTransport = {
    userId: "",
    email: "",
    async pull(): Promise<PulledRemote> {
      const { data, error } = await supabase
        .from(CLOUD_TABLE)
        .select("doc, rev")
        .eq("user_id", found.userId)
        .maybeSingle();
      if (error) {
        if (looksLikeMissingTable(error)) throw new Error(error.message);
        throw new Error(error.message);
      }
      if (!data) return { envelope: null, rev: 0 };
      return { envelope: (data as { doc: CloudEnvelope }).doc, rev: Number((data as { rev: number }).rev) || 0 };
    },
    async push(envelope: CloudEnvelope, baseRev: number): Promise<number | null> {
      if (baseRev <= 0) {
        const { error } = await supabase.from(CLOUD_TABLE).insert({
          user_id: found.userId,
          doc: envelope,
          rev: 1,
          device_id: envelope.deviceId,
        });
        if (error) {
          // 23505 = 主键冲突：这一行已经被别人建出来了 → 当成版本冲突处理
          if (error.code === "23505") return null;
          throw new Error(error.message);
        }
        return 1;
      }

      /*
       * 乐观并发的关键就在这个 `.eq('rev', baseRev)`：只有「我读到的那个版本
       * 还没人动过」时才写得进去。期间别的设备写过 → rev 已经变了 →
       * 这一行匹配不到 → data 为 null → 返回 null 让调用方去合并。
       * **不许无条件覆盖**，那会静默吃掉对方的改动。
       */
      const { data, error } = await supabase
        .from(CLOUD_TABLE)
        .update({
          doc: envelope,
          rev: baseRev + 1,
          device_id: envelope.deviceId,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", found.userId)
        .eq("rev", baseRev)
        .select("rev")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return Number((data as { rev: number }).rev);
    },
  };
  return found;
}

/** 拿当前会话建一个可用的传输层；没登录就返回 null */
async function ensureTransport(): Promise<CloudTransport | null> {
  if (!isCloudConfigured()) return null;
  const supabase = getClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  const session = data.session;
  if (!session) {
    transport = null;
    setState({ signedIn: false, email: null, phase: "off" });
    return null;
  }

  const email = session.user.email ?? "";
  if (transport === null || transport.userId !== session.user.id) {
    const built = makeSupabaseTransport();
    if (!built) return null;
    built.userId = session.user.id;
    built.email = email;
    transport = built;
    tombstones = loadTombstones(session.user.id);
  }

  setState({ signedIn: true, email, phase: state.phase === "off" ? "idle" : state.phase });
  return transport;
}

/* ------------------------------------------------------------------ */
/* 同步主流程                                                          */
/* ------------------------------------------------------------------ */

export type SyncTrigger = "start" | "local" | "visible" | "online" | "manual";

/**
 * 同步一次。所有触发方式都走这里，于是「限流」「排队」「冲突重试」
 * 只有一份实现。
 */
export async function syncNow(trigger: SyncTrigger = "manual"): Promise<void> {
  if (!isCloudConfigured()) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // 离线不是「出错」——本地照样能用，等联网了会自动再试
    setState({ phase: "error", lastError: networkMessage() });
    return;
  }

  // 焦点 / 切前台 / 联网这类高频触发要限流；手动点的不限
  if (trigger !== "manual" && trigger !== "local" && Date.now() - lastSyncMs < MIN_INTERVAL_MS) {
    return;
  }

  /*
   * 排到链尾。用 then 的两个参数而不是 catch：不管上一次成功还是失败，
   * 这一次都要照跑（上一次失败不该把后面的同步堵死）。
   */
  const run = chain.then(
    () => performSync(),
    () => performSync(),
  );
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

/** 真正跑一次同步：状态、失败处理都在这里，链只负责排队 */
async function performSync(): Promise<void> {
  setState({ phase: "syncing", lastError: null });
  try {
    await runSync();
    lastSyncMs = Date.now();
    setState({ phase: "idle", lastSyncAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === CONFLICT_PENDING) {
      // 不是错误：还有东西没推上去，界面挂「待同步」，下次再试
      setState({ phase: "idle", pending: true });
    } else if (message === OUTDATED) {
      setState({ phase: "outdated", lastError: "云端数据来自更新版本的「回忆」。请升级程序后再同步，或者先用本机覆盖云端。" });
    } else {
      setState({ phase: "error", lastError: describeError(err) });
    }
  }
}

async function runSync(): Promise<void> {
  // 本地数据还没读出来之前不能同步：那一刻拿到的是空数据，
  // 推上去等于把云端那份清空。
  if (bindings === null || !ready) return;

  const active = await ensureTransport();
  if (!active) return;

  const local = bindings.getDecks();
  const remote = await active.pull();

  /* ---------------- 云端还没有数据 ---------------- */
  if (remote.envelope === null) {
    const envelope = makeEnvelope(local, tombstones, device);
    await pushWithConflictRetry(active, envelope, remote.rev);
    await markBound(active.userId);
    setState({ pending: false });
    return;
  }

  /* ---------------- 远端那份能不能用 ---------------- */
  const check = checkEnvelope(remote.envelope);
  if (!check.ok) {
    /*
     * 形状不对就**绝不合并** —— 本地那份是用户唯一的东西，
     * 不能拿一份读不懂的数据去合它。这里宁可报错让人来找原因。
     * 「数据结构版本比我高」单独说：那是程序该升级了，不是数据坏了。
     */
    if (check.reason === "badSchema") throw new Error(OUTDATED);
    throw new Error(`bad envelope: ${check.reason}`);
  }
  if (remote.envelope.v > ENVELOPE_VERSION) throw new Error(OUTDATED);
  if (remote.envelope.schemaVersion > SCHEMA_VERSION) throw new Error(OUTDATED);

  /* ---------------- 首次绑定：两边都有卡片就先问 ---------------- */
  /*
   * 只在**两边都真的录了卡片**时才问。新设备第一次打开可能已经有一个空卡组，
   * 那时候问「用这台设备还是用云端」是多余的吓唬 —— 合并只会做加法，
   * 本来就没有可丢的东西，直接合了更省事。
   */
  const bound = isBound(active.userId);
  if (!bound && hasAnyCards(local) && hasAnyCards(remote.envelope.decks)) {
    pendingChoice = { envelope: remote.envelope, rev: remote.rev };
    setState({
      choice: {
        localDecks: local.length,
        remoteDecks: remote.envelope.decks.length,
        remoteAt: remote.envelope.savedAt,
      },
    });
    return;
  }

  /* ---------------- 合并 → 落地 → 推 ---------------- */
  await reconcile(active, remote.envelope, remote.rev);

  if (!bound) await markBound(active.userId);
}

/**
 * 合并远端、把结果落到本地、必要时推回去。
 *
 * 顺序不能动：**先合、再落、最后推**。
 * 先推的话，推上去的是没合过的那份，对方的改动就被整份盖掉了。
 */
async function reconcile(
  active: CloudTransport,
  remoteEnvelope: CloudEnvelope,
  rev: number,
): Promise<void> {
  if (bindings === null) return;
  const local = bindings.getDecks();
  const mine = makeEnvelope(local, tombstones, device);
  const merged = mergeEnvelopes(mine, remoteEnvelope);

  if (merged.dataChanged || merged.removed > 0) {
    bindings.applyDecks(merged.decks);
    if (merged.removed > 0) {
      // 别的设备删掉了东西 —— 这台设备上它刚刚消失。必须说一声。
      bindings.notify(`另一台设备删除了 ${merged.removed} 个卡组，本机已同步`);
    }
  }

  tombstones = merged.deleted;
  saveTombstones(active.userId, tombstones);

  const outgoing = makeEnvelope(merged.decks, merged.deleted, device);
  // 内容没变就别推了：每次推都会让另一台设备白拉一次
  if (sameEnvelopeContent(outgoing, remoteEnvelope)) {
    setState({ pending: false });
    return;
  }

  await pushWithConflictRetry(active, outgoing, rev);
  setState({ pending: false });
}

/**
 * 推上去；如果版本冲突（期间别的设备写过），拉下来合并再推。
 *
 * 这里是「手机上的改动被电脑整份盖掉」唯一的防线：
 * 冲突时**没有一条路径是无条件覆盖**，必须先合并。
 */
async function pushWithConflictRetry(
  active: CloudTransport,
  envelope: CloudEnvelope,
  baseRev: number,
): Promise<number> {
  if (bindings === null) throw new Error("cloud not bound");
  let current = envelope;
  let rev = baseRev;

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const nextRev = await active.push(current, rev);
    if (nextRev !== null) return nextRev;

    // 冲突：先看对方写了什么
    const remote = await active.pull();
    if (remote.envelope === null) {
      // 对方把那一行删了（换账号 / 手工清理）→ 当成重新插入
      rev = 0;
      continue;
    }
    const check = checkEnvelope(remote.envelope);
    if (!check.ok) {
      if (check.reason === "badSchema") throw new Error(OUTDATED);
      throw new Error(`bad envelope: ${check.reason}`);
    }
    if (remote.envelope.v > ENVELOPE_VERSION) throw new Error(OUTDATED);
    if (remote.envelope.schemaVersion > SCHEMA_VERSION) throw new Error(OUTDATED);

    const local = bindings.getDecks();
    const merged = mergeEnvelopes(makeEnvelope(local, tombstones, device), remote.envelope);
    if (merged.dataChanged) {
      bindings.applyDecks(merged.decks);
      if (merged.removed > 0) {
        bindings.notify(`另一台设备删除了 ${merged.removed} 个卡组，本机已同步`);
      }
    }
    tombstones = merged.deleted;
    saveTombstones(active.userId, tombstones);
    current = makeEnvelope(merged.decks, merged.deleted, device);
    rev = remote.rev;
  }

  // 连着冲突好几次（两边都在猛写）—— **不弹错误**，只挂个「还有没推上去的」。
  // 下一次同步或用户点一下就好了；这里弹错反而会让人以为数据坏了。
  throw new Error(CONFLICT_PENDING);
}

/* ------------------------------------------------------------------ */
/* 首次绑定：用哪一边                                                  */
/* ------------------------------------------------------------------ */

export type FirstSyncStrategy = "merge" | "push" | "pull";

/**
 * 第一次在这台设备上开启同步、而云端已经有卡片时，用哪一边？
 *
 * 为什么不替用户决定：两边都有东西时，「合并」会得到双份的卡组
 * （各自建的 id 不同），「覆盖」会丢掉一边。哪一种更合适只有他自己知道。
 * 所以这里只是把三种结果讲清楚，让他选，并且**默认选中合并**。
 */
export async function resolveFirstSync(strategy: FirstSyncStrategy): Promise<void> {
  const pending = pendingChoice;
  const active = transport;
  if (!pending || !active || bindings === null) return;

  pendingChoice = null;
  setState({ choice: null, phase: "syncing" });

  try {
    const local = bindings.getDecks();

    if (strategy === "pull") {
      // 用云端的覆盖本机：连墓碑一起接过来，否则本机的删除会反过来删云端
      tombstones = mergeTombstones(emptyTombstones(), pending.envelope.deleted);
      saveTombstones(active.userId, tombstones);
      bindings.applyDecks(pending.envelope.decks);
      markBound(active.userId);
      setState({ phase: "idle", pending: false, lastSyncAt: new Date().toISOString() });
      bindings.notify("已用云端的数据覆盖本机");
      return;
    }

    if (strategy === "push") {
      // 用本机的覆盖云端：墓碑清空（本机现在这份就是唯一真相）
      tombstones = emptyTombstones();
      saveTombstones(active.userId, tombstones);
      const envelope = makeEnvelope(local, tombstones, device);
      await pushWithConflictRetry(active, envelope, pending.rev);
      markBound(active.userId);
      setState({ phase: "idle", pending: false, lastSyncAt: new Date().toISOString() });
      bindings.notify("已用本机的数据覆盖云端");
      return;
    }

    await reconcile(active, pending.envelope, pending.rev);
    markBound(active.userId);
    setState({ phase: "idle", lastSyncAt: new Date().toISOString() });
    bindings.notify("已合并本机与云端的数据");
  } catch (err) {
    setState({ phase: "error", lastError: describeError(err) });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 登录 / 退出                                                         */
/* ------------------------------------------------------------------ */

export interface AuthOutcome {
  ok: boolean;
  /** 注册成功但还需要去邮箱点确认链接 */
  needsEmailConfirm?: boolean;
  error?: string;
}

export async function signUpCloud(email: string, password: string): Promise<AuthOutcome> {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: "云端还没有配置（.env 里缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）。" };
  try {
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    if (error) return { ok: false, error: describeAuthError(error.message) };
    // 项目开了「确认邮箱」时，注册完还拿不到会话 —— 必须让人知道要去点邮件
    if (!data.session) return { ok: true, needsEmailConfirm: true };
    // 登录成功与首次同步是两件事；网络慢时不能把已成功的登录误报成失败。
    try {
      await afterSignIn();
    } catch {
      // 后台同步会在网络恢复、切回前台或手动点击时重试。
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err instanceof Error ? err.message : String(err)) };
  }
}

export async function signInCloud(email: string, password: string): Promise<AuthOutcome> {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: "云端还没有配置（.env 里缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）。" };
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, error: describeAuthError(error.message) };
    await afterSignIn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err instanceof Error ? err.message : String(err)) };
  }
}

export async function signOutCloud(): Promise<void> {
  const supabase = getClient();
  transport = null;
  tombstones = emptyTombstones();
  pendingChoice = null;
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  setState({
    signedIn: false,
    email: null,
    phase: "off",
    lastSyncAt: null,
    lastError: null,
    pending: false,
    choice: null,
  });
  if (supabase) await supabase.auth.signOut();
}

async function afterSignIn(): Promise<void> {
  await ensureTransport();
  // 登录之后立刻同步一次 —— 用户在手机上登录，本来就是想看到电脑上的数据
  await syncNow("manual");
}

/* ------------------------------------------------------------------ */
/* 本地改动 → 记墓碑 + 排一次推送                                       */
/* ------------------------------------------------------------------ */

/**
 * 本地数据变了 → 记墓碑 + 排一次推送。
 *
 * 用「前后两份数据的差」而不是让每个操作主动报告删了什么：
 * 删除的入口有好几个（删卡片、删卡组……），漏掉任何一个都会让删除
 * 悄悄失去同步能力。比对两份数据的差是**唯一一个不可能漏**的位置。
 */
export function cloudLocalDecksChanged(prev: Deck[], next: Deck[]): void {
  if (transport === null) return;

  const at = Date.now();
  const removals = collectDeckRemovals(prev, next, at);
  if (Object.keys(removals.decks).length > 0 || Object.keys(removals.cards).length > 0) {
    tombstones = mergeTombstones(tombstones, removals);
    // 不 await：这是一条订阅回调，不能拖住界面
    saveTombstones(transport.userId, tombstones);
  }

  if (state.choice !== null) return; // 等用户选完再推，否则等于替他做了决定

  setState({ pending: true });
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void syncNow("local");
  }, PUSH_DELAY_MS);
}
