import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, Brain, Check, ChevronLeft, ChevronRight, CircleHelp, Cloud, Database,
  Clock3, FileText, FolderPlus, Layers3, LoaderCircle, MoreHorizontal, Pencil, Plus, Settings2, Sparkles,
  Trash2, Upload, X,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";
import {
  advanceEbbinghaus, countBlanks, createCard, Deck, dueCards, EBBINGHAUS_DAYS, formatDue,
  makeId, oneClickCloze, splitMaterial, Card,
} from "./lib/study";
import { ClozeText, everyBlank, toggleBlank } from "./components/ClozeText";
import { generateCards, GenerateError, Progress, SEGMENT_CHARS, Usage } from "./lib/generate";
import { bindCloud, cloudLocalDecksChanged, cloudMarkReady } from "./lib/cloud";
import { CloudPanel, FirstSyncDialog, cloudDotClass, cloudStatusLabel, useCloud } from "./components/CloudPanel";
import { BackupPanel } from "./components/BackupPanel";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type View = "today" | "round" | "cards" | "create";
type Draft = Pick<Card, "kind" | "front" | "back" | "source" | "section">;
const STORAGE_KEY = "huixiang-decks-v1";
const PREFS_KEY = "huixiang-prefs-v1";

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTokens(total: number): string {
  if (total >= 10000) return `${(total / 1000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function readDecks(): Deck[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as Deck[]; }
  catch { return []; }
}

function readModelPrefs() {
  let saved: { baseUrl?: string; model?: string } = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); }
  catch { /* use defaults */ }
  const migrated = saved.baseUrl === "https://www.a8pi.com/v1" || saved.model === "gpt6.1sol";
  const prefs = {
    baseUrl: !saved.baseUrl || saved.baseUrl === "https://www.a8pi.com/v1" ? "https://api.deepseek.com" : saved.baseUrl,
    model: !saved.model || saved.model === "gpt6.1sol" ? "deepseek-flash" : saved.model,
  };
  if (migrated) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    sessionStorage.removeItem("huixiang-api-key");
  }
  return prefs;
}

async function extractFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) return file.text();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return pages.join("\n");
  }
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error("支持 TXT、Markdown、PDF 和 DOCX 文件。");
}

export default function App() {
  const [decks, setDecks] = useState<Deck[]>(readDecks);
  const [activeDeckId, setActiveDeckId] = useState<string | null>(() => readDecks()[0]?.id ?? null);
  const [view, setView] = useState<View>("today");
  const [material, setMaterial] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [deckName, setDeckName] = useState("");
  const [addToDeckId, setAddToDeckId] = useState<string | null>(null);
  const [density, setDensity] = useState<"少" | "多">("少");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [savingDrafts, setSavingDrafts] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPrefs] = useState(readModelPrefs);
  const [baseUrl, setBaseUrl] = useState(modelPrefs.baseUrl);
  const [model, setModel] = useState(modelPrefs.model);
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("huixiang-api-key") || "");
  const [roundIndex, setRoundIndex] = useState(0);
  const [roundShown, setRoundShown] = useState<Set<number>>(() => new Set());
  const [roundAnswerShown, setRoundAnswerShown] = useState(false);
  const [roundDone, setRoundDone] = useState(false);
  const [reviewShown, setReviewShown] = useState<Set<number>>(() => new Set());
  const [reviewAnswerShown, setReviewAnswerShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [menuDeckId, setMenuDeckId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDeckId, setDeleteDeckId] = useState<string | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const cloud = useCloud();
  const persistQueue = useRef(Promise.resolve());
  const renameCancelled = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const runRef = useRef<AbortController | null>(null);
  const segmentsRef = useRef(new Map<number, Draft[]>());
  /** 引擎读最新卡组用（同步回调可能晚于渲染，不能用闭包里的旧值） */
  const decksRef = useRef<Deck[]>(decks);
  /** 上一次的卡组，用于比对「哪些 id 消失了」→ 记删除墓碑 */
  const prevDecksRef = useRef<Deck[]>(decks);
  /** 从云端合并落下来的那次 deck 变化不算「本地改动」，别反过来记墓碑再推 */
  const appliedFromSync = useRef(false);

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // 进入重命名时把光标放进输入框。
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  // 卡组操作菜单：点外面或按 Esc 收起。
  useEffect(() => {
    if (!menuDeckId) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".deck-entry")) return;
      setMenuDeckId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuDeckId(null);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuDeckId]);

  // 把「读/写卡组」的口子交给云端引擎，并开始监听在线状态、会话变化。
  // 只在挂载时跑一次；StrictMode 会把 effect 跑两遍，bindCloud 是幂等的。
  useEffect(() => {
    bindCloud({
      getDecks: () => decksRef.current,
      applyDecks: (list) => {
        appliedFromSync.current = true;
        decksRef.current = list;
        setDecks(list);
        // 当前选中的卡组可能刚被别的设备删掉 —— 换到还在的第一个
        setActiveDeckId((current) => list.some((deck) => deck.id === current) ? current : list[0]?.id ?? null);
      },
      notify: (message) => flash(message),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/data");
        if (!response.ok) throw new Error("本地数据读取失败");
        const stored = await response.json() as { decks?: Deck[] };
        if (cancelled) return;
        const diskDecks = Array.isArray(stored.decks) ? stored.decks : [];
        const browserDecks = readDecks();
        const initialDecks = diskDecks.length ? diskDecks : browserDecks;
        decksRef.current = initialDecks;
        prevDecksRef.current = initialDecks;
        setDecks(initialDecks);
        setActiveDeckId((current) => initialDecks.some((deck) => deck.id === current) ? current : initialDecks[0]?.id ?? null);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initialDecks));
      } catch {
        if (!cancelled) setError("无法连接本地保存服务。请从启动脚本打开，数据目前仅保存在此浏览器。");
      } finally {
        if (!cancelled) {
          setDataReady(true);
          // 本地数据读出来了，云端这时才允许开始同步（否则会拿空数据把云端清空）
          cloudMarkReady();
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!dataReady) return;
    // 同步引擎读的是 decksRef，所以每次 deck 变化都要先把它刷成最新
    decksRef.current = decks;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
    persistQueue.current = persistQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/data", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decks }),
        });
        if (!response.ok) throw new Error("disk save failed");
      })
      .catch(() => setError("本地文件保存失败，卡片暂时留在浏览器缓存中。请检查目录权限。"));
    // 云端：本地改动 → 比对出删除了哪些卡组/卡片并记墓碑，再延迟推送。
    // 从云端合并落地的那次变化要跳过，否则会把「别的设备的删除」当成自己的删除再传回去。
    if (appliedFromSync.current) {
      appliedFromSync.current = false;
    } else {
      cloudLocalDecksChanged(prevDecksRef.current, decks);
    }
    prevDecksRef.current = decks;
  }, [decks, dataReady]);

  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const due = useMemo(() => activeDeck ? dueCards(activeDeck) : [], [activeDeck]);
  const totalDue = decks.reduce((sum, deck) => sum + dueCards(deck).length, 0);

  function updateDecks(next: Deck[] | ((current: Deck[]) => Deck[])) {
    setDecks((current) => {
      const value = typeof next === "function" ? next(current) : next;
      return value;
    });
  }

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      const text = await extractFile(file);
      setMaterial(text);
      setMaterialName(file.name);
      if (!deckName) setDeckName(file.name.replace(/\.[^.]+$/, ""));
      flash(`已导入 ${file.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取文件失败。");
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  }

  function makeOneClickCards() {
    setError("");
    const result = oneClickCloze(material, density);
    if (!result.length) {
      setError("没找到适合自动挖空的句子。试试导入完整段落，或用 AI 生成。");
      return;
    }
    setDrafts(result);
    setView("create");
    flash(`已生成 ${result.length} 张挖空卡`);
  }

  function addManualCard(kind: "cloze" | "qa") {
    setDrafts((current) => [...current, { kind, front: "", back: "", section: "未分类" }]);
  }

  async function makeAiCards(kind: "cloze" | "qa") {
    setError("");
    if (!material.trim()) { setError("先粘贴或导入一段材料。"); return; }
    if (!apiKey.trim()) { setSettingsOpen(true); setError("先在设置中填写 API Key。"); return; }
    if (!splitMaterial(material, SEGMENT_CHARS).length) { setError("没有找到可发送的材料内容。"); return; }

    setDrafts([]);
    segmentsRef.current = new Map();
    setProgress({ total: 0, done: 0, cards: 0, failures: 0, truncated: 0, tokens: 0, cachedSegments: 0 });
    setBusy(true);
    const controller = new AbortController();
    runRef.current = controller;

    const publishDrafts = () => {
      const merged = [...segmentsRef.current.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, cards]) => cards);
      setDrafts(merged);
    };

    try {
      const result = await generateCards({
        material,
        input: { baseUrl, apiKey, model, kind, density },
        signal: controller.signal,
        onProgress: setProgress,
        onSegment: (order, cards) => {
          segmentsRef.current.set(order, cards.map((card) => createCard({
            kind, front: card.front, back: card.back, section: card.section || "未分类", source: materialName || undefined,
          })));
          publishDrafts();
        },
        post: async (text, signal) => {
          const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseUrl, apiKey, model, kind, density, text }),
            signal,
          });
          let payload: { cards?: { front: string; back: string; section?: string }[]; truncated?: boolean; error?: string; code?: string; usage?: Usage } = {};
          try { payload = await response.json(); } catch { /* 上游可能返回非 JSON 错误页，按失败处理 */ }
          if (!response.ok) throw new GenerateError(payload.error || `生成失败（${response.status}）`, response.status, payload.code);
          return { cards: payload.cards ?? [], truncated: payload.truncated, usage: payload.usage };
        },
      });

      const spent = result.tokens ? `（消耗 ${formatTokens(result.tokens)}）` : "";
      if (result.cancelled) {
        flash(`已停止生成，保留 ${result.cards.length} 张卡片${spent}`);
      } else if (result.failures.length) {
        const failed = result.failures.map((failure) => `第 ${Math.round(failure.segment) + 1} 段`).join("、");
        setError(`${failed}没有生成成功，其余 ${result.cards.length} 张卡片已保留${spent}。可再点一次补生成，或把材料拆小一些。`);
      } else {
        const cached = result.cachedSegments ? `，${result.cachedSegments} 段命中缓存没花钱` : "";
        flash(result.truncated
          ? `已生成 ${result.cards.length} 张卡片${spent}${cached}（${result.truncated} 段输出较长，已尽量保留）`
          : `已生成 ${result.cards.length} 张卡片${spent}${cached}`);
      }
    } catch (e) {
      setError(e instanceof Error ? `生成中断：${e.message}。已生成的卡片仍保留在下方。` : "AI 生成失败，已生成的卡片仍保留在下方。");
    } finally {
      runRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }

  async function saveDrafts() {
    const cards = drafts
      .filter((card) => card.front.trim() && card.back.trim())
      .map((card) => createCard(card));
    if (!cards.length) { setError("至少填写一张完整卡片。"); return; }
    const now = Date.now();
    const newDeck: Deck = { id: makeId(), name: deckName.trim() || materialName || "新卡组", createdAt: now, updatedAt: now, cards, rounds: 0 };
    const nextDecks = addToDeckId
      ? decks.map((deck) => deck.id === addToDeckId ? { ...deck, updatedAt: now, cards: [...deck.cards, ...cards] } : deck)
      : [newDeck, ...decks];
    const savedDeckId = addToDeckId || newDeck.id;
    setSavingDrafts(true);
    setError("");
    try {
      const response = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decks: nextDecks }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "本地保存失败。");
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDecks));
      setDecks(nextDecks);
      setActiveDeckId(savedDeckId);
      setDrafts([]);
      setAddToDeckId(null);
      setView("today");
      setMaterial("");
      setMaterialName("");
      flash(`已保存 ${cards.length} 张卡片到本机`);
    } catch (e) {
      setError(e instanceof Error ? `保存失败：${e.message}。卡片仍在当前编辑页，请重试。` : "保存失败，卡片仍在当前编辑页。");
    } finally {
      setSavingDrafts(false);
    }
  }

  function startRound() {
    if (!activeDeck?.cards.length) return;
    setRoundIndex(0);
    setRoundShown(new Set());
    setRoundAnswerShown(false);
    setRoundDone(false);
    setView("round");
  }

  function finishRoundCard() {
    if (!activeDeck) return;
    if (roundIndex + 1 < activeDeck.cards.length) {
      setRoundIndex((index) => index + 1);
      setRoundShown(new Set());
      setRoundAnswerShown(false);
      return;
    }
    const now = Date.now();
    updateDecks((current) => current.map((deck) => deck.id === activeDeck.id ? {
      ...deck,
      rounds: deck.rounds + 1,
      updatedAt: now,
      cards: deck.cards.map((card) => ({ ...card, roundSeen: card.roundSeen + 1, updatedAt: now })),
    } : deck));
    setRoundDone(true);
  }

  function rateReview(remembered: boolean) {
    if (!activeDeck || !due[0]) return;
    const card = due[0];
    const now = Date.now();
    const next = advanceEbbinghaus(card, remembered, now);
    updateDecks((current) => current.map((deck) => deck.id === activeDeck.id
      ? { ...deck, updatedAt: now, cards: deck.cards.map((item) => item.id === card.id ? next : item) }
      : deck));
    setReviewShown(new Set());
    setReviewAnswerShown(false);
  }

  function deleteCard(cardId: string) {
    if (!activeDeck) return;
    updateDecks((current) => current.map((deck) => deck.id === activeDeck.id
      ? { ...deck, updatedAt: Date.now(), cards: deck.cards.filter((card) => card.id !== cardId) }
      : deck));
  }

  function deleteDeck(deckId: string) {
    updateDecks((current) => current.filter((deck) => deck.id !== deckId));
    if (activeDeckId === deckId) setActiveDeckId(decks.find((deck) => deck.id !== deckId)?.id ?? null);
    setView("today");
  }

  function beginRename(deck: Deck) {
    setMenuDeckId(null);
    renameCancelled.current = false;
    setRenamingId(deck.id);
    setRenameValue(deck.name);
  }

  function commitRename() {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      setRenamingId(null);
      return;
    }
    const name = renameValue.trim();
    const target = renamingId;
    setRenamingId(null);
    if (!target) return;
    if (!name) { flash("卡组名称不能为空"); return; }
    updateDecks((current) => current.map((deck) => deck.id === target ? { ...deck, name, updatedAt: Date.now() } : deck));
    flash(`已重命名为「${name}」`);
  }

  function askDeleteDeck(deckId: string) {
    setMenuDeckId(null);
    setDeleteDeckId(deckId);
  }

  function saveSettings() {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ baseUrl: baseUrl.trim(), model: model.trim() }));
    sessionStorage.setItem("huixiang-api-key", apiKey.trim());
    setApiKey(apiKey.trim());
    setSettingsOpen(false);
    flash("设置已保存");
  }

  async function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    await loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  const currentRoundCard = activeDeck?.cards[roundIndex];
  const reviewCard = due[0];

  // 换卡（复习或环比上一张）时，把“点了哪几个空”的状态清掉。
  useEffect(() => {
    setReviewShown(new Set());
    setReviewAnswerShown(false);
  }, [reviewCard?.id]);
  useEffect(() => {
    setRoundShown(new Set());
    setRoundAnswerShown(false);
  }, [currentRoundCard?.id]);

  const reviewBlankTotal = reviewCard?.kind === "cloze" ? countBlanks(reviewCard.front) : 0;
  const reviewAllShown = reviewCard
    ? (reviewCard.kind === "cloze" ? reviewBlankTotal > 0 && reviewShown.size >= reviewBlankTotal : reviewAnswerShown)
    : false;
  const roundBlankTotal = currentRoundCard?.kind === "cloze" ? countBlanks(currentRoundCard.front) : 0;
  const roundAllShown = currentRoundCard
    ? (currentRoundCard.kind === "cloze" ? roundBlankTotal > 0 && roundShown.size >= roundBlankTotal : roundAnswerShown)
    : false;

  function toggleReviewBlank(index: number) {
    setReviewShown((current) => toggleBlank(current, index));
  }

  function toggleReviewAll() {
    if (!reviewCard) return;
    if (reviewCard.kind !== "cloze") { setReviewAnswerShown((value) => !value); return; }
    setReviewShown((current) => (reviewBlankTotal > 0 && current.size >= reviewBlankTotal) ? new Set() : everyBlank(reviewBlankTotal));
  }

  function toggleRoundBlank(index: number) {
    setRoundShown((current) => toggleBlank(current, index));
  }

  function toggleRoundAll() {
    if (!currentRoundCard) return;
    if (currentRoundCard.kind !== "cloze") { setRoundAnswerShown((value) => !value); return; }
    setRoundShown((current) => (roundBlankTotal > 0 && current.size >= roundBlankTotal) ? new Set() : everyBlank(roundBlankTotal));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Brain size={19} /></span><span>回想<span className="brand-en">MEMO</span></span></div>
        <button className="new-deck-button" onClick={() => { setView("create"); setDrafts([]); setAddToDeckId(null); setError(""); }}><Plus size={17} /> 新建卡组</button>
        <div className="side-label">学习空间</div>
        <button className={`side-link ${view === "today" ? "active" : ""}`} onClick={() => setView("today")}><Clock3 size={17} /><span>今日复习</span>{totalDue > 0 && <b>{totalDue}</b>}</button>
        <div className="side-label deck-label">我的卡组 <span>{decks.length}</span></div>
        <div className="deck-list">
          {decks.map((deck) => (
            <div className={`deck-entry ${activeDeckId === deck.id ? "selected" : ""} ${menuDeckId === deck.id ? "menu-open" : ""}`} key={deck.id}>
              <div className="deck-row">
                {renamingId === deck.id
                  ? <input
                      className="deck-rename"
                      ref={renameInputRef}
                      value={renameValue}
                      autoFocus
                      aria-label="卡组名称"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") { renameCancelled.current = true; setRenamingId(null); }
                      }}
                      onBlur={commitRename}
                    />
                  : <button className={`deck-link ${activeDeckId === deck.id ? "selected" : ""}`} onClick={() => { setActiveDeckId(deck.id); setView("cards"); }}><span className="deck-dot" /><span className="deck-name">{deck.name}</span><span className="deck-count">{deck.cards.length}</span></button>}
                <button
                  className="deck-more"
                  title="卡组操作"
                  aria-label={`${deck.name} 的操作`}
                  aria-expanded={menuDeckId === deck.id}
                  onClick={() => setMenuDeckId((current) => current === deck.id ? null : deck.id)}
                ><MoreHorizontal size={15} /></button>
              </div>
              {menuDeckId === deck.id && renamingId !== deck.id && (
                <div className="deck-menu" role="menu">
                  <button role="menuitem" onClick={() => beginRename(deck)}><Pencil size={13} />重命名</button>
                  <button role="menuitem" className="danger" onClick={() => askDeleteDeck(deck.id)}><Trash2 size={13} />删除卡组</button>
                </div>
              )}
            </div>
          ))}
          {!decks.length && <p className="empty-decks">还没有卡组</p>}
        </div>
        <button className="cloud-entry" onClick={() => setCloudOpen(true)} title="账号与云端同步">
          <span className={`cloud-dot ${cloudDotClass(cloud)}`} />
          <span className="cloud-entry-label">{cloudStatusLabel(cloud)}</span>
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><p className="eyebrow">PERSONAL STUDY SPACE</p><h1>{view === "today" ? "学习总览" : view === "round" ? "循环背诵" : view === "cards" ? activeDeck?.name || "卡片" : "导入与制卡"}</h1></div>
          <div className="top-actions"><div className="today-date">{dataReady ? "本机自动保存" : "正在读取本机数据"}</div><button className="icon-button" title="数据与备份" onClick={() => setBackupOpen(true)}><Database size={19} /></button><button className="icon-button" title="账号与云端同步" onClick={() => setCloudOpen(true)}><Cloud size={19} /></button><button className="icon-button" title="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /></button></div>
        </header>

        <nav className="view-tabs" aria-label="学习模式">
          <button className={view === "today" ? "current" : ""} onClick={() => setView("today")}><Clock3 size={16} />今日复习</button>
          <button className={view === "round" ? "current" : ""} onClick={startRound} disabled={!activeDeck?.cards.length}><Layers3 size={16} />逐轮背诵</button>
          <button className={view === "cards" ? "current" : ""} onClick={() => setView("cards")} disabled={!activeDeck}><BookOpen size={16} />卡片管理</button>
          <button className={view === "create" ? "current" : ""} onClick={() => { setAddToDeckId(null); setDrafts([]); setView("create"); }}><Sparkles size={16} />导入制卡</button>
        </nav>

        {view === "today" && <section className="page-content">
          <div className="summary-strip">
            <div className="summary-item"><span className="summary-icon green"><Clock3 size={18} /></span><div><strong>{due.length}</strong><small>待复习</small></div></div>
            <div className="summary-item"><span className="summary-icon blue"><Layers3 size={18} /></span><div><strong>{decks.reduce((n, deck) => n + deck.cards.length, 0)}</strong><small>总卡片</small></div></div>
            <div className="summary-item"><span className="summary-icon orange"><Brain size={18} /></span><div><strong>{decks.reduce((n, deck) => n + deck.rounds, 0)}</strong><small>完成轮次</small></div></div>
          </div>
          {activeDeck ? <div className="study-layout">
            <section className="review-column">
              <div className="section-heading"><div><h2>开始学习</h2><p>选择一个卡组，继续今天的记忆训练</p></div><button className="text-button" onClick={() => setView("cards")}>查看卡片 <ChevronRight size={15} /></button></div>
              <div className="primary-deck-row">
                <div className="deck-cover"><BookOpen size={22} /></div>
                <div className="primary-deck-info"><strong>{activeDeck.name}</strong><span>{activeDeck.cards.length} 张卡片 · 已完成 {activeDeck.rounds} 轮</span></div>
                <button className="button-primary" onClick={startRound} disabled={!activeDeck.cards.length}>开始一轮 <ChevronRight size={16} /></button>
              </div>
              <div className="section-heading section-spaced"><div><h2>艾宾浩斯复习</h2><p>根据复习进度安排下一次回想</p></div><span className="tag tag-green">间隔记忆</span></div>
              <div className="review-panel">
                {due.length ? <>
                  <div className="review-topline"><span className="review-counter">今日到期 <b>{due.length}</b></span><span className="review-position">{activeDeck.cards.length - due.length + 1} / {activeDeck.cards.length}</span></div>
                  <div className="flashcard" onClick={toggleReviewAll} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") toggleReviewAll(); }}>
                    <div className="current-section"><span>当前章节</span><strong>{due[0].section || "未分类"}</strong></div>
                    <div className="card-type">{due[0].kind === "cloze" ? "挖空回想" : "问答回想"}</div>
                    <div className="card-prompt">{due[0].kind === "cloze" ? <ClozeText text={due[0].front} shown={reviewShown} onToggle={toggleReviewBlank} /> : due[0].front}</div>
                    {reviewAllShown && <div className="card-answer">{due[0].back}</div>}
                    <div className="card-hint">{due[0].kind === "cloze"
                      ? (reviewAllShown ? "全部显示了，选择记忆情况" : "点空看答案 · 点空白处全部显示")
                      : (reviewAllShown ? "想起来了吗？选择记忆情况" : "点空白处显示答案")}</div>
                  </div>
                  {reviewAllShown && <div className="rate-actions"><button className="button-soft" onClick={() => rateReview(false)}>没记住 <span>明日再复习</span></button><button className="button-primary" onClick={() => rateReview(true)}><Check size={16} />记住了 <span>{formatDue(Date.now() + EBBINGHAUS_DAYS[Math.min(due[0].stage + 1, EBBINGHAUS_DAYS.length - 1)] * 86400000)}</span></button></div>}
                </> : <div className="review-empty"><span className="done-mark"><Check size={20} /></span><div><strong>今天没有到期卡片</strong><span>{activeDeck.cards.length ? `下一张 ${formatDue(Math.min(...activeDeck.cards.map((card) => card.dueAt)))}` : "导入材料，创建你的第一组卡片"}</span></div><button className="text-button" onClick={() => setView("create")}>导入材料 <ChevronRight size={15} /></button></div>}
              </div>
            </section>
            <aside className="round-aside"><div className="aside-title"><h3>背诵轮次</h3><span className="tag">当前卡组</span></div><div className="round-number">{activeDeck.rounds}<small>轮</small></div><p>完整过完一遍卡组，轮次就会累加。</p><div className="round-progress"><span style={{ width: `${activeDeck.cards.length ? Math.min(100, activeDeck.cards.filter((card) => card.roundSeen > 0).length / activeDeck.cards.length * 100) : 0}%` }} /></div><div className="round-foot"><span>卡组掌握进度</span><b>{activeDeck.cards.filter((card) => card.roundSeen > 0).length}/{activeDeck.cards.length}</b></div><button className="outline-button" onClick={startRound}>继续逐轮背诵 <ChevronRight size={15} /></button><div className="interval-block"><div className="interval-title"><span>复习间隔</span><CircleHelp size={15} /></div><div className="interval-pills">{[0, 1, 2, 4, 7, 15].map((day) => <span key={day}>{day === 0 ? "今天" : `${day}天`}</span>)}</div></div></aside>
          </div> : <div className="welcome-import"><div className="welcome-copy"><span className="welcome-symbol"><Sparkles size={20} /></span><p className="eyebrow">START WITH YOUR MATERIAL</p><h2>把材料变成<br />可以回想的卡片</h2><p className="welcome-sub">导入讲义、粘贴笔记，选择挖空密度，再开始循环背诵。</p><button className="button-primary" onClick={() => setView("create")}>导入材料 <ChevronRight size={16} /></button></div><div className="empty-stats"><div><strong>01</strong><span>导入材料</span></div><div><strong>02</strong><span>生成卡片</span></div><div><strong>03</strong><span>开始背诵</span></div></div></div>}
        </section>}

        {view === "create" && <section className="page-content create-page">
          <div className="create-heading"><div><p className="eyebrow">MATERIAL IN</p><h2>{addToDeckId ? `向「${deckName}」添加卡片` : "导入内容，生成记忆卡"}</h2><p>卡片会自动保存到本机，也可以手动逐条录入后一起保存。</p></div>{!addToDeckId && <div className="name-field"><label htmlFor="deck-name">卡组名称</label><input id="deck-name" value={deckName} onChange={(e) => setDeckName(e.target.value)} placeholder="例如：生物学 · 细胞结构" /></div>}</div>
          <div className="import-grid">
            <div className={`material-pane ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              <div className="pane-header"><div><FileText size={18} /><strong>学习材料</strong>{materialName && <span className="file-name">{materialName}</span>}</div><label className="icon-text-button"><Upload size={15} />导入文件<input type="file" accept=".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf" onChange={onFileInput} hidden /></label></div>
              <textarea value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="粘贴讲义、课程笔记或需要背诵的内容……\n\n也可以把 TXT、Markdown、PDF 或 DOCX 文件拖到这里。" />
              <div className="material-footer"><span>{material.length.toLocaleString()} 字符</span><span>TXT · MD · PDF · DOCX</span></div>
            </div>
            <div className="make-pane">
              <div className="pane-header"><div><Sparkles size={18} /><strong>生成方式</strong></div><button className="settings-inline" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />模型</button></div>
              <div className="density-label"><span>挖空数量</span><span className="density-note">每张卡的空数</span></div>
              <div className="segmented density-selector"><button className={density === "少" ? "selected" : ""} onClick={() => setDensity("少")}>少 <span>1 个关键空</span></button><button className={density === "多" ? "selected" : ""} onClick={() => setDensity("多")}>多 <span>1–2 个关联空</span></button></div>
              <div className="generation-actions"><button className="button-primary full-button" onClick={() => void makeAiCards("cloze")} disabled={busy || !material.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}AI 帮我挖空</button><button className="button-outline full-button" onClick={makeOneClickCards} disabled={!material.trim()}><Brain size={16} />一键挖空</button><button className="button-outline full-button" onClick={() => void makeAiCards("qa")} disabled={busy || !material.trim()}><CircleHelp size={16} />AI 生成问答卡</button><button className="button-outline full-button" onClick={() => addManualCard("qa")}><Plus size={15} />手动录入多张卡</button></div>
              <div className="model-caption"><span className={apiKey ? "key-ready" : "key-missing"} />{model || "未设置模型"}<button onClick={() => setSettingsOpen(true)}>{apiKey ? "已配置" : "设置 API"}</button></div>
            </div>
          </div>
          {progress && busy && (() => {
            const percent = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
            const waiting = progress.total > progress.done;
            return (
              <div className={`progress-panel ${waiting ? "is-waiting" : ""}`} role="status" aria-live="polite">
                <div className="progress-head">
                  <span className="progress-title"><LoaderCircle className="spin" size={14} />正在生成卡片</span>
                  <span className="progress-figures">{progress.done}/{progress.total} 段 · {progress.cards} 张 · {formatDuration(elapsed)} · {formatTokens(progress.tokens)}</span>
                </div>
                <div className={`progress-track ${waiting ? "indeterminate" : ""}`}><span style={{ width: `${Math.max(percent, 3)}%` }} /></div>
                <div className="progress-foot">
                  <span>{progress.failures ? `${progress.failures} 段失败，结束后汇总` : `模型：${model || "未设置"} · ${progress.truncated ? "已自动接住长输出" : "逐段生成中"}`}</span>
                  <button className="progress-stop" onClick={() => runRef.current?.abort()}>停止</button>
                </div>
              </div>
            );
          })()}
          {error && <div className="inline-error"><X size={15} />{error}</div>}
          <div className="flow-footer"><span><Layers3 size={15} />生成后可以逐张编辑、删除，再保存为卡组</span><button className="text-button" onClick={() => setView("today")}>返回学习总览</button></div>
        </section>}

        {view === "create" && drafts.length > 0 && <section className="draft-section"><div className="draft-heading"><div><span className="eyebrow">CARD PREVIEW</span><h2>检查卡片 <span>{drafts.length}</span>{busy && <em className="draft-live">仍在生成…</em>}</h2></div><div className="draft-actions"><button className="button-outline" onClick={() => addManualCard("qa")}><Plus size={15} />再加一张</button><button className="button-primary" onClick={() => void saveDrafts()} disabled={!dataReady || savingDrafts}>{savingDrafts ? <LoaderCircle className="spin" size={15} /> : <Check size={16} />}{savingDrafts ? "保存中" : addToDeckId ? `追加 ${drafts.length} 张` : `保存 ${drafts.length} 张`}</button></div></div><div className="draft-grid">{drafts.map((card, index) => <article className="draft-card" key={index}><div className="draft-card-head"><span>{card.kind === "cloze" ? "挖空" : "问答"} · {String(index + 1).padStart(2, "0")}</span><button className="icon-button small-icon" title="删除卡片" onClick={() => setDrafts((items) => items.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div><label className="section-field">所属章节<input value={card.section || ""} placeholder="例如：一、链路形态" onChange={(e) => setDrafts((items) => items.map((item, i) => i === index ? { ...item, section: e.target.value } : item))} /></label><label>正面<textarea value={card.front} onChange={(e) => setDrafts((items) => items.map((item, i) => i === index ? { ...item, front: e.target.value } : item))} /></label><label>答案<textarea value={card.back} onChange={(e) => setDrafts((items) => items.map((item, i) => i === index ? { ...item, back: e.target.value } : item))} /></label></article>)}</div></section>}

        {view === "round" && <section className="page-content round-page">{!activeDeck ? <EmptyState onCreate={() => setView("create")} /> : roundDone ? <div className="round-finished"><span className="done-mark large-done"><Check size={25} /></span><p className="eyebrow">ROUND COMPLETE</p><h2>第 {activeDeck.rounds} 轮完成</h2><p>这一轮的 {activeDeck.cards.length} 张卡片已全部过完。</p><div className="finished-actions"><button className="button-primary" onClick={startRound}>再背一轮 <ChevronRight size={16} /></button><button className="button-outline" onClick={() => setView("today")}>返回总览</button></div></div> : currentRoundCard ? <><div className="round-toolbar"><button className="back-button" onClick={() => setView("today")}><ChevronLeft size={16} />学习总览</button><div className="round-title">{activeDeck.name}<span>第 {activeDeck.rounds + 1} 轮</span></div><div className="round-counter">{roundIndex + 1} <span>/</span> {activeDeck.cards.length}</div></div><div className="round-track"><span style={{ width: `${((roundIndex + (roundAllShown ? 0.5 : 0)) / activeDeck.cards.length) * 100}%` }} /></div><div className="round-card" onClick={toggleRoundAll} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") toggleRoundAll(); }}><div className="current-section"><span>当前章节</span><strong>{currentRoundCard.section || "未分类"}</strong></div><span className="card-type">{currentRoundCard.kind === "cloze" ? "挖空回想" : "问答回想"}</span><div className="round-prompt">{currentRoundCard.kind === "cloze" ? <ClozeText text={currentRoundCard.front} shown={roundShown} onToggle={toggleRoundBlank} /> : currentRoundCard.front}</div>{roundAllShown && <div className="round-answer">{currentRoundCard.back}</div>}<div className="card-hint">{currentRoundCard.kind === "cloze" ? (roundAllShown ? "看完后继续下一张" : "点空看答案 · 点空白处全部显示") : (roundAllShown ? "看完后继续下一张" : "想好答案后，点空白处显示")}</div></div><div className="round-bottom"><span>已完成 {activeDeck.rounds} 轮 · 每张都过完后记为新的一轮</span><button className="button-primary" onClick={() => roundAllShown ? finishRoundCard() : toggleRoundAll()}>{roundAllShown ? roundIndex + 1 === activeDeck.cards.length ? "完成本轮" : "下一张" : "显示答案"}<ChevronRight size={16} /></button></div></> : null}</section>}

        {view === "cards" && <section className="page-content cards-page">{activeDeck ? <><div className="section-heading cards-heading"><div><h2>{activeDeck.name}</h2><p>{activeDeck.cards.length} 张卡片 · 已背诵 {activeDeck.rounds} 轮</p></div><div className="card-tools"><button className="button-outline" onClick={() => { setDeckName(activeDeck.name); setAddToDeckId(activeDeck.id); setDrafts([]); setView("create"); }}><Plus size={15} />继续加卡</button><button className="button-primary" onClick={startRound}>逐轮背诵 <ChevronRight size={15} /></button><button className="icon-button danger-icon" title="删除卡组" onClick={() => askDeleteDeck(activeDeck.id)}><Trash2 size={16} /></button></div></div><div className="card-list">{activeDeck.cards.map((card, i) => <article className="saved-card" key={card.id}><span className="saved-index">{String(i + 1).padStart(2, "0")}</span><div className="saved-main"><div className="saved-front"><span className={`tag ${card.kind === "cloze" ? "tag-amber" : "tag-blue"}`}>{card.kind === "cloze" ? "挖空" : "问答"}</span><p>{card.kind === "cloze" ? <ClozeText text={card.front} /> : card.front}</p></div><p className="saved-back">{card.back}</p></div><div className="saved-meta"><span>第 {card.roundSeen} 轮</span><span className={card.dueAt <= Date.now() ? "due-now" : ""}>{formatDue(card.dueAt)}</span></div><button className="icon-button small-icon" title="删除卡片" onClick={() => deleteCard(card.id)}><Trash2 size={15} /></button></article>)}{!activeDeck.cards.length && <EmptyState onCreate={() => setView("create")} />}</div></> : <EmptyState onCreate={() => setView("create")} />}</section>}
      </main>

      {deleteDeckId && (() => {
        const target = decks.find((deck) => deck.id === deleteDeckId);
        if (!target) return null;
        return <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setDeleteDeckId(null)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="delete-deck-title"><div className="modal-header"><div><span className="eyebrow">DELETE DECK</span><h2 id="delete-deck-title">删除《{target.name}》？</h2></div><button className="icon-button" onClick={() => setDeleteDeckId(null)} title="关闭"><X size={18} /></button></div><p className="settings-note">这个卡组里的 {target.cards.length} 张卡牌会一起删掉，删除后不可恢复。</p><div className="modal-actions"><button className="button-outline" onClick={() => setDeleteDeckId(null)}>取消</button><button className="button-primary danger-button" onClick={() => { const name = target.name; deleteDeck(target.id); setDeleteDeckId(null); flash(`已删除《${name}》`); }}><Trash2 size={15} />确认删除</button></div></section></div>;
      })()}
      {settingsOpen && <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><span className="eyebrow">DEEPSEEK API</span><h2 id="settings-title">模型设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} title="关闭"><X size={18} /></button></div><label>API Base URL<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" /></label><label>模型 ID<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-flash" /></label><label>DeepSeek API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="粘贴 DeepSeek API Key" autoComplete="off" /></label><p className="settings-note">Key 仅保存在当前浏览器会话；模型地址与 ID 保存在本机浏览器。</p><p className="settings-note">制卡建议用 deepseek-flash：推理型模型（deepseek-v4-pro）会先「想」一大段，思考 token 是 deepseek-flash 的 2–3 倍，速度还慢一倍以上。</p><div className="modal-actions"><button className="button-outline" onClick={() => setSettingsOpen(false)}>取消</button><button className="button-primary" onClick={saveSettings}>保存设置 <Check size={15} /></button></div></section></div>}
      <CloudPanel open={cloudOpen} onClose={() => setCloudOpen(false)} />
      <BackupPanel
        open={backupOpen}
        decks={decks}
        onClose={() => setBackupOpen(false)}
        onApply={(next, message) => {
          setBackupOpen(false);
          setDecks(next);
          setActiveDeckId((current) => next.some((deck) => deck.id === current) ? current : next[0]?.id ?? null);
          flash(message);
        }}
      />
      <FirstSyncDialog onError={(message) => flash(message)} />
      {notice && <div className="toast"><Check size={16} />{notice}</div>}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><span className="empty-icon"><FolderPlus size={22} /></span><h2>这里还没有卡片</h2><p>导入一份材料，开始建立自己的背诵卡组。</p><button className="button-primary" onClick={onCreate}>导入材料 <ChevronRight size={16} /></button></div>;
}
