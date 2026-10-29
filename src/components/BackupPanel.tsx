import { useState } from "react";
import { Download, LoaderCircle, Upload, X } from "lucide-react";
import type { Deck } from "../lib/study";
import { createBackup, mergeBackupDecks, parseBackup } from "../lib/backup";

interface Pending {
  decks: Deck[];
  exportedAt: string | null;
  fileName: string;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function downloadJson(content: string, fileName: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 「数据与备份」弹窗。
 *
 * 只处理本机数据，和云端同步无关：
 *   · 导出：把全部卡组 + 卡片 + 复习进度存成一个 JSON 文件
 *   · 导入：可选「合并」（只做加法）或「覆盖」（替换本机全部卡组）
 */
export function BackupPanel({
  open,
  decks,
  onClose,
  onApply,
}: {
  open: boolean;
  decks: Deck[];
  onClose: () => void;
  onApply: (next: Deck[], message: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const totalCards = decks.reduce((sum, deck) => sum + deck.cards.length, 0);
  const pendingCards = pending ? pending.decks.reduce((sum, deck) => sum + deck.cards.length, 0) : 0;

  async function onFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setPending(null);
    setConfirmReplace(false);
    try {
      const parsed = parseBackup(await file.text());
      if (!parsed.decks.length) {
        setError("这个备份里没有卡组。");
        return;
      }
      setPending({ decks: parsed.decks, exportedAt: parsed.exportedAt, fileName: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取备份失败。");
    }
  }

  function exportNow() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    downloadJson(createBackup(decks), `huixiang-backup-${stamp}.json`);
  }

  function applyMerge() {
    if (!pending) return;
    setBusy(true);
    try {
      const merged = mergeBackupDecks(decks, pending.decks);
      onApply(merged, `已合并导入 ${pending.decks.length} 个卡组`);
    } finally {
      setBusy(false);
    }
  }

  function applyReplace() {
    if (!pending) return;
    setBusy(true);
    try {
      onApply(pending.decks, `已用备份覆盖本机数据（${pending.decks.length} 个卡组）`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-modal backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">BACKUP & RESTORE</span>
            <h2 id="backup-title">数据与备份</h2>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <p className="cloud-hint">
          备份和导入都只在本机生效：导出会下载一个 JSON 文件（含卡组、卡片和复习进度），
          以后换设备或出问题时用它恢复。与云端同步无关。
        </p>

        <div className="backup-card">
          <strong>导出备份</strong>
          <p>
            当前共 {decks.length} 个卡组 · {totalCards} 张卡片。导出的文件建议自己存到网盘或微信收藏里。
          </p>
          <div className="backup-actions">
            <button className="button-outline" onClick={exportNow} disabled={!decks.length}>
              <Download size={15} /> 导出 .json
            </button>
          </div>
        </div>

        <div className="backup-card">
          <strong>导入备份</strong>
          <p>选择之前导出的 .json 文件。导入前会先预览内容，确认后才写入。</p>
          <div className="backup-actions">
            <label className="button-outline backup-file-label">
              <Upload size={15} /> 选择文件
              <input type="file" accept=".json,application/json" onChange={onFileInput} hidden />
            </label>
          </div>
        </div>

        {error && <div className="cloud-error">{error}</div>}

        {pending && (
          <div className="backup-pending">
            <strong>
              已读取「{pending.fileName}」：{pending.decks.length} 个卡组 · {pendingCards} 张卡片
            </strong>
            {pending.exportedAt && <div className="backup-note">备份导出时间：{formatTime(pending.exportedAt)}</div>}

            {!confirmReplace ? (
              <>
                <div className="backup-note">选择导入方式：</div>
                <div className="backup-actions">
                  <button className="button-primary" onClick={applyMerge} disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                    合并导入（推荐）
                  </button>
                  <button className="button-outline" onClick={() => setConfirmReplace(true)} disabled={busy}>
                    <Upload size={15} /> 覆盖导入
                  </button>
                </div>
                <p className="backup-note">
                  合并导入只做加法：本机没有的卡组原样追加，同 id 的卡组按较新的复习进度为准，不会丢东西。
                </p>
              </>
            ) : (
              <>
                <p className="backup-note danger-text">
                  覆盖导入会用这份备份替换本机现在的 {decks.length} 个卡组。若已登录云端同步，被移除的卡组会在其他设备上一并删除。
                </p>
                <div className="backup-actions">
                  <button className="button-outline" onClick={() => setConfirmReplace(false)} disabled={busy}>
                    取消
                  </button>
                  <button className="button-primary danger-button" onClick={applyReplace} disabled={busy}>
                    <Upload size={15} /> 确认覆盖
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <p className="cloud-meta">
          本机数据同时保存在 <code>data/study-data.json</code>（通过本地服务运行时）和浏览器缓存里。
          备份文件才是你真正带到别的设备上的东西。
        </p>
      </section>
    </div>
  );
}
