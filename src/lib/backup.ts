/**
 * 数据备份：导出 / 解析 / 合并（全部是纯函数，方便单测）。
 *
 * 导出文件格式：
 *   { format: "huixiang-backup", version: 1, exportedAt, decks: Deck[] }
 *
 * 导入兼容三种形状：
 *   · 本应用导出的完整备份对象
 *   · 旧格式（只有 { decks } 的对象）
 *   · 裸的 decks 数组
 *
 * 合并规则和云端同步一致：按 id 求并集，同一个卡组 / 同一张卡按
 * 较新的 updatedAt 为准；本机没有的原样追加，两边都有但内容相同的就留
 * updatedAt 更新那份。合并只做加法 —— 导入不会悄悄丢东西。
 */

import type { Card, Deck } from "./study";

export const BACKUP_FORMAT = "huixiang-backup";
export const BACKUP_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeId(): string {
  return crypto.randomUUID();
}

/** 卡组「最后一次被动过」的时间（老数据没有 updatedAt 时用创建时间兜底） */
export function backupDeckTime(deck: Deck): number {
  return deck.updatedAt ?? deck.createdAt ?? 0;
}

/** 卡片「最后一次被动过」的时间（老卡片没有 updatedAt 时按 0 算） */
export function backupCardTime(card: Card): number {
  return card.updatedAt ?? 0;
}

/** 生成备份 JSON 文本 */
export function createBackup(decks: Deck[], now = Date.now()): string {
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    decks,
  };
  return JSON.stringify(payload, null, 2);
}

export interface ParsedBackup {
  decks: Deck[];
  /** 备份里的导出时间（没有就 null） */
  exportedAt: string | null;
}

/**
 * 解析并校验备份文本。
 *
 * 校验是「宁可拒绝，不要硬塞」：结构不对就抛错给用户看，
 * 绝不把读不懂的数据塞进卡组里 —— 那是用户唯一的那份东西。
 */
export function parseBackup(text: string): ParsedBackup {
  let raw: unknown;
  try {
    // 有些编辑器会在文件开头加 BOM（\uFEFF），JSON.parse 会直接报错
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("不是有效的 JSON 文件。");
  }

  let decksValue: unknown;
  let exportedAt: string | null = null;
  if (Array.isArray(raw)) {
    decksValue = raw;
  } else if (isRecord(raw)) {
    decksValue = raw.decks;
    if (typeof raw.exportedAt === "string") exportedAt = raw.exportedAt;
  }

  if (!Array.isArray(decksValue)) {
    throw new Error("文件里没有找到卡组数据（decks）。");
  }

  const decks = decksValue.map((item, index) => normalizeDeck(item, index));
  return { decks, exportedAt };
}

function normalizeDeck(value: unknown, index: number): Deck {
  if (!isRecord(value)) throw new Error(`第 ${index + 1} 个卡组的数据格式不对。`);
  if (!Array.isArray(value.cards)) throw new Error(`第 ${index + 1} 个卡组缺少卡片列表（cards）。`);

  const cards = value.cards.map((item, cardIndex) => normalizeCard(item, index, cardIndex));
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : undefined;

  return {
    id: typeof value.id === "string" && value.id ? value.id : makeId(),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "导入的卡组",
    createdAt,
    cards,
    rounds: typeof value.rounds === "number" && value.rounds >= 0 ? value.rounds : 0,
    updatedAt,
  };
}

function normalizeCard(value: unknown, deckIndex: number, cardIndex: number): Card {
  const where = `第 ${deckIndex + 1} 个卡组里的第 ${cardIndex + 1} 张卡片`;
  if (!isRecord(value)) throw new Error(`${where}格式不对。`);
  if (typeof value.front !== "string" || !value.front.trim()) throw new Error(`${where}缺少正面内容。`);
  if (typeof value.back !== "string" || !value.back.trim()) throw new Error(`${where}缺少答案内容。`);

  return {
    id: typeof value.id === "string" && value.id ? value.id : makeId(),
    kind: value.kind === "qa" ? "qa" : "cloze",
    front: value.front,
    back: value.back,
    section: typeof value.section === "string" ? value.section : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    roundSeen: typeof value.roundSeen === "number" && value.roundSeen >= 0 ? value.roundSeen : 0,
    stage: typeof value.stage === "number" && value.stage >= 0 ? value.stage : 0,
    dueAt: typeof value.dueAt === "number" ? value.dueAt : Date.now(),
    lastReviewed: typeof value.lastReviewed === "number" ? value.lastReviewed : undefined,
    reviewSkipRound: typeof value.reviewSkipRound === "number" && Number.isInteger(value.reviewSkipRound) && value.reviewSkipRound > 0 ? value.reviewSkipRound : undefined,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
  };
}

/**
 * 把备份合并进本机数据（只做加法）。
 *
 *   · 本机没有的卡组：原样追加
 *   · 两边都有的卡组：名字取 updatedAt 较新那份、轮次取较大值、
 *     卡片逐张合并（同一张卡按 updatedAt 较新的赢，相同时保留本机的 ——
 *     本机的复习进度更可能是最新的）
 */
export function mergeBackupDecks(local: Deck[], incoming: Deck[]): Deck[] {
  const byId = new Map<string, Deck>();
  for (const deck of local) byId.set(deck.id, deck);

  for (const deck of incoming) {
    const existing = byId.get(deck.id);
    if (!existing) {
      byId.set(deck.id, deck);
      continue;
    }
    const newest = backupDeckTime(deck) >= backupDeckTime(existing) ? deck : existing;
    byId.set(deck.id, {
      ...newest,
      createdAt: Math.min(existing.createdAt, deck.createdAt),
      rounds: Math.max(existing.rounds, deck.rounds),
      cards: mergeBackupCards(existing.cards, deck.cards),
    });
  }

  // 和应用展示顺序一致：新卡组在前；创建时间相同按 id 兜底，保证结果确定
  return [...byId.values()].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function mergeBackupCards(local: Card[], incoming: Card[]): Card[] {
  const byId = new Map<string, Card>();
  const order: string[] = [];
  for (const card of local) {
    byId.set(card.id, card);
    order.push(card.id);
  }
  for (const card of incoming) {
    const existing = byId.get(card.id);
    if (!existing) {
      byId.set(card.id, card);
      order.push(card.id);
    } else if (backupCardTime(card) > backupCardTime(existing)) {
      byId.set(card.id, card);
    }
  }
  return order.map((id) => byId.get(id) as Card);
}
