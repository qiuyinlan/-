import { useSyncExternalStore, useState } from "react";
import { Cloud, LoaderCircle, LogIn, LogOut, RefreshCw, UserPlus, X } from "lucide-react";
import {
  cloudConfigProblem,
  cloudFailureDetail,
  currentDeviceId,
  getCloudState,
  resolveFirstSync,
  signInCloud,
  signOutCloud,
  signUpCloud,
  subscribeCloud,
  syncNow,
  type CloudState,
} from "../lib/cloud";

/** 订阅云端状态（useSyncExternalStore 的标准用法） */
export function useCloud(): CloudState {
  return useSyncExternalStore(subscribeCloud, getCloudState, getCloudState);
}

/** 侧边栏 / 顶栏那一句状态文案 */
export function cloudStatusLabel(cloud: CloudState): string {
  if (!cloud.configured) return "仅本机保存 · 云端未配置";
  if (!cloud.signedIn) return "本机自动保存 · 云端未登录";
  if (cloud.phase === "syncing") return "正在同步云端…";
  if (cloud.phase === "outdated") return "云端版本更新，需要升级";
  if (cloud.phase === "error") return "同步失败，点击查看";
  if (cloud.pending) return "有改动待同步";
  return "云端已同步";
}

/** 状态点颜色 */
export function cloudDotClass(cloud: CloudState): string {
  if (!cloud.configured) return "";
  if (!cloud.signedIn) return "";
  if (cloud.phase === "syncing") return "sync";
  if (cloud.phase === "error" || cloud.phase === "outdated") return "err";
  if (cloud.pending) return "sync";
  return "on";
}

function formatTime(iso: string | null): string {
  if (!iso) return "还没有同步过";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const CONFIG_HINT = (
  <>
    <p className="cloud-hint">
      云端还没有配置。在项目根目录建一个 <code>.env</code> 文件，填上 Supabase 控制台
      （Project Settings → API）里那两个公开值，然后重新构建：
    </p>
    <code className="cloud-code">{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co\nVITE_SUPABASE_ANON_KEY=<anon / publishable key>`}</code>
    <p className="cloud-hint">
      建表脚本在项目里的 <code>supabase/schema.sql</code>，配置步骤见 <code>docs/supabase-接入步骤.md</code>。
      没配置时应用完全照旧：数据只存在本机（浏览器 + 本机文件），不受任何影响。
    </p>
  </>
);

/**
 * 「账号与云端同步」弹窗。
 *
 * 三种状态各有一块内容：
 *   1. 没配置云端   → 告诉用户怎么配（以及本机功能不受影响）
 *   2. 配了但没登录 → 登录 / 注册表单
 *   3. 登录了       → 同步状态、上次同步时间、立即同步、退出登录
 */
export function CloudPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cloud = useCloud();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  if (!open) return null;

  async function submit() {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError("请填写邮箱。");
      return;
    }
    if (!password) {
      setError("请填写密码。");
      return;
    }
    setBusy(true);
    try {
      const outcome = mode === "in" ? await signInCloud(email, password) : await signUpCloud(email, password);
      if (!outcome.ok) {
        setError(outcome.error ?? "操作失败，请重试。");
        return;
      }
      if (outcome.needsEmailConfirm) {
        setNotice("注册成功！请先去邮箱点确认链接，然后回来登录。");
        return;
      }
      setPassword("");
      setNotice(mode === "in" ? "登录成功。" : "注册成功。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-modal cloud-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">SUPABASE CLOUD</span>
            <h2 id="cloud-title">账号与云端同步</h2>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* ---------- 没配置 ---------- */}
        {!cloud.configured && (
          <>
            {cloudConfigProblem === "secretKey" && (
              <div className="cloud-error">
                你填的那把钥匙是 Secret key（或 service_role）——它能绕过数据访问规则，绝不能放进网页。
                请去 Supabase 控制台换成 anon / Publishable key，并且立刻把刚才那把 Secret key 删除重发。
              </div>
            )}
            {cloudConfigProblem === "placeholder" && (
              <div className="cloud-error">
                .env 里还是模板占位值，请换成真实项目的 URL 和 anon key，然后重新构建。
              </div>
            )}
            {CONFIG_HINT}
            <p className="cloud-hint">
              为什么要登录：两台设备（电脑 + 手机）用同一个账号登录后，卡组和复习进度会自动对上。
              不登录也能用，只是数据只在这台本机上。
            </p>
          </>
        )}

        {/* ---------- 配了没登录 ---------- */}
        {cloud.configured && !cloud.signedIn && (
          <>
            <p className="cloud-hint">用邮箱注册或登录。同一个邮箱在两台设备上登录，数据就会同步到一起。</p>
            <div className="cloud-tabs">
              <button className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setError(null); setNotice(null); }}>
                <LogIn size={14} /> 登录
              </button>
              <button className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setError(null); setNotice(null); }}>
                <UserPlus size={14} /> 注册
              </button>
            </div>
            <div className="cloud-form">
              <label>
                邮箱
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  placeholder="you@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  placeholder={mode === "in" ? "输入密码" : "至少 6 位"}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </label>
            </div>
            {error && <div className="cloud-error">{error}</div>}
            {notice && <div className="cloud-notice">{notice}</div>}
            <div className="cloud-actions">
              <button className="button-primary" onClick={() => void submit()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={15} /> : mode === "in" ? <LogIn size={15} /> : <UserPlus size={15} />}
                {busy ? "请稍候" : mode === "in" ? "登录" : "注册"}
              </button>
            </div>
          </>
        )}

        {/* ---------- 已登录 ---------- */}
        {cloud.configured && cloud.signedIn && (
          <>
            <div className="cloud-status">
              <span className={`cloud-dot ${cloudDotClass(cloud)}`} />
              <div>
                <strong>{cloud.email ?? "已登录"}</strong>
                <div>
                  上次同步：{formatTime(cloud.lastSyncAt)}
                  {cloud.pending ? " · 还有改动没推上去" : ""}
                </div>
                {cloud.phase === "error" && cloud.lastError && <div className="cloud-error">{cloud.lastError}</div>}
                {cloud.phase === "outdated" && cloud.lastError && <div className="cloud-error">{cloud.lastError}</div>}
                {cloud.phase === "error" && cloudFailureDetail() && (
                  <>
                    <button
                      type="button"
                      className="cloud-detail-link"
                      onClick={() => setDetailOpen((value) => !value)}
                    >
                      {detailOpen ? "收起技术细节" : "展开技术细节"}
                    </button>
                    {detailOpen && <code className="cloud-code">{cloudFailureDetail()}</code>}
                  </>
                )}
              </div>
            </div>
            <p className="cloud-hint">
              这台设备的编号：<code>{currentDeviceId()}</code>。两台设备用同一个账号时数据会自动合并：
              新增的都会留下，删除的会传过去。本地数据始终是最近一次同步后的副本，断网也能继续用。
            </p>
            <div className="cloud-actions">
              <button className="button-primary" onClick={() => void syncNow("manual")} disabled={cloud.phase === "syncing"}>
                {cloud.phase === "syncing" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {cloud.phase === "syncing" ? "同步中…" : "立即同步"}
              </button>
              <button className="button-outline" onClick={() => { setNotice(null); setError(null); void signOutCloud(); }}>
                <LogOut size={15} /> 退出登录
              </button>
            </div>
            <div className="cloud-meta">
              <span>退出登录不会删除任何数据：本机数据还在，云端数据也在，下次登录继续同步。</span>
            </div>
          </>
        )}

      </section>
    </div>
  );
}

/**
 * 首次绑定弹窗：云端已经有卡片、本机也有卡片时，等用户决定用哪边。
 *
 * 不替用户决定：合并会得到双份卡组（各自建的 id 不同），覆盖会丢掉一边。
 * 默认选中「合并」——它只会做加法，两边都保留。
 */
export function FirstSyncDialog({ onError }: { onError: (message: string) => void }) {
  const cloud = useCloud();
  const [busy, setBusy] = useState(false);
  const choice = cloud.choice;

  if (!choice) return null;

  async function pick(strategy: "merge" | "push" | "pull") {
    setBusy(true);
    try {
      await resolveFirstSync(strategy);
    } catch (err) {
      onError(err instanceof Error ? err.message : "同步失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  const remoteTime = formatTime(choice.remoteAt);

  return (
    <div className="modal-backdrop">
      <section className="settings-modal cloud-modal" role="dialog" aria-modal="true" aria-labelledby="first-sync-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">FIRST SYNC</span>
            <h2 id="first-sync-title">云端已有数据，用哪边？</h2>
          </div>
        </div>
        <p className="cloud-hint">
          云端有 {choice.remoteDecks} 个卡组（{remoteTime} 保存），本机也有 {choice.localDecks} 个卡组。
          第一次连接请选一次；之后两边会自动合并。
        </p>
        <div className="cloud-choice">
          <button className="recommend" disabled={busy} onClick={() => void pick("merge")}>
            <strong>合并两边（推荐）</strong>
            <span>本机新增的、云端新增的都会保留；同一张卡片按较新的复习进度为准</span>
          </button>
          <button disabled={busy} onClick={() => void pick("push")}>
            <strong>用本机覆盖云端</strong>
            <span>云端那份会被本机替换（云端独有的卡组会丢）</span>
          </button>
          <button disabled={busy} onClick={() => void pick("pull")}>
            <strong>用云端覆盖本机</strong>
            <span>本机那份会被云端替换（本机独有的卡组会丢）</span>
          </button>
        </div>
        {busy && (
          <p className="cloud-hint">
            <LoaderCircle className="spin" size={13} /> 正在同步…
          </p>
        )}
        <p className="cloud-hint">
          <Cloud size={13} /> 提示：合并之后两边的卡组都会在；只有「两边都各建了一份同名卡组」时才会出现重复。
        </p>
      </section>
    </div>
  );
}
