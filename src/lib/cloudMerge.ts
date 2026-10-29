/**
 * 云端同步 · 信封格式与合并规则（全部是纯函数）。
 *
 * 照「断舍离」的 src/cloud/envelope.ts 改造而来，只是把「物品」换成了
 * 「卡组 / 卡片」：
 *
 *   · decks    本体 —— 就是本机那份 Deck[]
 *   · deleted  删除墓碑：卡组 / 卡片各自 id → 删除时间（毫秒）
 *   · deviceId 最后写这份信封的设备
 *   · savedAt  写入时间
 *
 * ── 为什么非要删除墓碑不可 ──────────────────────────────────────────
 * 合并只做加法：本地有、对方没有的东西一律留着。这对「导入备份」是对的，
 * 但对同步是灾难：在电脑上删掉一个卡组，同步时手机会把它当成
 * 「我这儿有、你那儿没有」——原样加回来。于是删除变成了「删了又回来」。
 *
 * 所以删除必须有痕迹：删卡组 / 删卡片时记一条墓碑，合并时按墓碑把
 * 对应的东西按下去；墓碑本身也要合并（两台设备各删各的）。
 *
 * ── 时间怎么比 ──────────────────────────────────────────────────────
 * 卡组有 updatedAt（最后一次动它的时间，创建时也有），卡片有 updatedAt
 * （记忆进度变化时刷新）。
 * 墓碑只有在**比这个时间更新**时才生效：删完之后又在另一台设备上改过，
 * 改动更晚 → 改动赢。这条和「updatedAt 较新者胜」是同一个原则。
 */

import type { Card, Deck } from "./study";

/** 信封格式版本。结构变了就 +1，老客户端读到更高的版本会拒绝处理 */
export const ENVELOPE_VERSION = 1;

/** 数据结构版本 —— 老客户端不许往新数据上写 */
export const SCHEMA_VERSION = 1;

/** 删除墓碑保留多久。超过这个时间没同步过的设备，删除可能失效（见 pruneTombstones） */
export const TOMBSTONE_TTL_DAYS = 180;

/** 删除墓碑：id → 删除时间（毫秒时间戳） */
export interface DeckTombstones {
  /** 卡组 id → 删除时间 */
  decks: Record<string, number>;
  /** 卡片 id → 删除时间（卡片 id 全局唯一） */
  cards: Record<string, number>;
}

export function emptyTombstones(): DeckTombstones {
  return { decks: {}, cards: {} };
}

export interface CloudEnvelope {
  v: number;
  schemaVersion: number;
  decks: Deck[];
  deleted: DeckTombstones;
  deviceId: string;
  savedAt: string;
}

/** 卡组「最后一次被动过」的时间。老数据没有 updatedAt 时退回到创建时间 */
export function deckTime(deck: Deck): number {
  return deck.updatedAt ?? deck.createdAt ?? 0;
}

/** 卡片「最后一次被动过」的时间。老卡片没有 updatedAt 时按 0 算（最旧） */
export function cardTime(card: Card): number {
  return card.updatedAt ?? 0;
}

/* ------------------------------------------------------------------ */
/* 信封构造与校验                                                      */
/* ------------------------------------------------------------------ */

export function makeEnvelope(
  decks: Deck[],
  deleted: DeckTombstones,
  deviceId: string,
  savedAt: string = new Date().toISOString(),
): CloudEnvelope {
  return { v: ENVELOPE_VERSION, schemaVersion: SCHEMA_VERSION, decks, deleted, deviceId, savedAt };
}

export interface EnvelopeCheck {
  ok: boolean;
  /** 不通过的原因（英文代号，由调用方翻成人话给用户看） */
  reason?: "notObject" | "versionTooNew" | "badSchema" | "badData" | "badDeleted";
}

/**
 * 远端拿到的这份信封能不能用。
 *
 * 远端那一行是**别的设备写上去的**，也可能是手工改坏的，甚至可能是
 * 以后某个更新版本写的。不校验就 merge 的话，形状不对的东西会一路混进
 * 本地数据 —— 而本地数据是用户唯一的那份东西。默认答案必须是
 * 「宁可拒绝，不要合」。
 */
export function checkEnvelope(value: unknown): EnvelopeCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "notObject" };
  }
  const env = value as Partial<CloudEnvelope>;

  if (typeof env.v !== "number" || env.v > ENVELOPE_VERSION) {
    return { ok: false, reason: "versionTooNew" };
  }
  if (typeof env.schemaVersion !== "number" || env.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, reason: "badSchema" };
  }
  if (!Array.isArray(env.decks)) return { ok: false, reason: "badData" };
  for (const deck of env.decks) {
    if (typeof deck !== "object" || deck === null) return { ok: false, reason: "badData" };
    const d = deck as Partial<Deck>;
    if (typeof d.id !== "string" || typeof d.name !== "string" || !Array.isArray(d.cards)) {
      return { ok: false, reason: "badData" };
    }
    for (const card of d.cards) {
      if (typeof card !== "object" || card === null || typeof (card as Partial<Card>).id !== "string") {
        return { ok: false, reason: "badData" };
      }
    }
  }

  const deleted = env.deleted ?? emptyTombstones();
  if (typeof deleted !== "object" || deleted === null || Array.isArray(deleted)) {
    return { ok: false, reason: "badDeleted" };
  }
  for (const map of [deleted.decks, deleted.cards]) {
    if (map === undefined) continue;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      return { ok: false, reason: "badDeleted" };
    }
    for (const at of Object.values(map)) {
      if (typeof at !== "number") return { ok: false, reason: "badDeleted" };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 比对                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把值序列化成「和键的顺序无关」的字符串。
 *
 * 远端那份数据是从 Postgres 的 jsonb 里取回来的，jsonb 存的是解析后的结构，
 * **不保留键的书写顺序**。直接用 JSON.stringify 比，「本地这份」和
 * 「刚从云端取回来的同一份」永远不相等 → 每次同步都判定有变化 → 推一遍 →
 * 拉回来又觉得变了 → 一直推下去。
 *
 * 数组顺序**必须保留**（数组顺序本身有意义的场景由调用方先排好），
 * 这里只排对象的键。
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 卡片内容形状：把 updatedAt 拿掉（它只影响「谁更新」，不代表内容差异） */
function cardShape(card: Card) {
  return {
    id: card.id,
    kind: card.kind,
    front: card.front,
    back: card.back,
    section: card.section,
    source: card.source,
    roundSeen: card.roundSeen,
    stage: card.stage,
    dueAt: card.dueAt,
    lastReviewed: card.lastReviewed,
  };
}

/**
 * 卡组内容形状：同样忽略 updatedAt。
 *
 * 集合顺序也要排掉（按 id 排）：合并是「以当前这份为主、对方新增的接在后面」，
 * 同一个结果在两台设备上的数组顺序天然不同。按数组位置比就是永远「不相等」，
 * 两台设备会互推个没完。卡片渲染顺序对内容没有意义，卡组本身按创建时间
 * 排好后两边一致可比。
 */
function deckShape(deck: Deck) {
  return {
    id: deck.id,
    name: deck.name,
    createdAt: deck.createdAt,
    rounds: deck.rounds,
    cards: [...deck.cards].map(cardShape).sort(byId),
  };
}

/** 两份 decks 的**内容**是不是一样（忽略 updatedAt，忽略集合顺序） */
export function sameDecksContent(a: Deck[], b: Deck[]): boolean {
  return canonical([...a].map(deckShape).sort(byId)) === canonical([...b].map(deckShape).sort(byId));
}

export function sameTombstones(a: DeckTombstones, b: DeckTombstones): boolean {
  return canonical(a) === canonical(b);
}

/** 这份信封推上去有用吗？不比 deviceId / savedAt —— 那两个每次都不同 */
export function sameEnvelopeContent(a: CloudEnvelope, b: CloudEnvelope): boolean {
  return sameDecksContent(a.decks, b.decks) && sameTombstones(a.deleted, b.deleted);
}

/* ------------------------------------------------------------------ */
/* 删除墓碑                                                            */
/* ------------------------------------------------------------------ */

/**
 * 对比前后两份数据，把「消失了的 id」记成墓碑。
 *
 * 只在**本机自己的改动**里调用（见 cloud.ts 里 decks 变化后的上报）。
 * 合并结果落地时不能调用，否则「别的设备删掉的东西」会被本机当成自己的删除
 * 再记一遍，来回传播。
 */
export function collectDeckRemovals(prev: Deck[], next: Deck[], at: number): DeckTombstones {
  const out = emptyTombstones();
  const nextDeckIds = new Set(next.map((deck) => deck.id));
  const nextCardIds = new Set(next.flatMap((deck) => deck.cards.map((card) => card.id)));
  for (const deck of prev) {
    if (!nextDeckIds.has(deck.id)) out.decks[deck.id] = at;
    for (const card of deck.cards) {
      if (!nextCardIds.has(card.id)) out.cards[card.id] = at;
    }
  }
  return out;
}

/** 两边各删各的 —— 按 id 取并集，同一个 id 保留更晚的那次删除时间 */
export function mergeTombstones(a: DeckTombstones, b: DeckTombstones): DeckTombstones {
  const decks = { ...a.decks };
  for (const [id, at] of Object.entries(b.decks)) {
    if (decks[id] === undefined || at > decks[id]) decks[id] = at;
  }
  const cards = { ...a.cards };
  for (const [id, at] of Object.entries(b.cards)) {
    if (cards[id] === undefined || at > cards[id]) cards[id] = at;
  }
  return { decks, cards };
}

/**
 * 丢掉「已经不用再记」的墓碑：
 *   1. 那条记录已经不在数据里了，而且墓碑也够老了 —— 给墓碑总数封顶；
 *   2. 那条记录还活着（改动时间比删除时间新，改动赢了）—— 留着没有意义，
 *      反而会在下次合并里再判一次。
 */
export function pruneTombstones(deleted: DeckTombstones, decks: Deck[], now: number = Date.now()): DeckTombstones {
  const cutoff = now - TOMBSTONE_TTL_DAYS * 24 * 3600 * 1000;

  const liveDecks = new Set<string>();
  const liveCards = new Set<string>();
  for (const deck of decks) {
    const deckAt = deleted.decks[deck.id];
    if (deckAt !== undefined && deckTime(deck) > deckAt) liveDecks.add(deck.id);
    for (const card of deck.cards) {
      const cardAt = deleted.cards[card.id];
      if (cardAt !== undefined && cardTime(card) > cardAt) liveCards.add(card.id);
    }
  }

  const keep = (map: Record<string, number>, live: Set<string>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(map)) {
      if (live.has(id)) continue;
      if (at < cutoff) continue;
      out[id] = at;
    }
    return out;
  };

  return {
    decks: keep(deleted.decks, liveDecks),
    cards: keep(deleted.cards, liveCards),
  };
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

/** 把墓碑落到卡组里的卡片上：删掉「最后一次改动早于删除时间」的卡片 */
function keepLiveCards(deck: Deck, tombstones: Record<string, number>): Deck {
  const cards = deck.cards.filter((card) => {
    const at = tombstones[card.id];
    return at === undefined || cardTime(card) > at;
  });
  return cards.length === deck.cards.length ? deck : { ...deck, cards };
}

/**
 * 同一个卡组在两台设备上都存在 —— 逐张卡片合并。
 *
 * 同一张卡片两边都改过时，按 updatedAt 较新的那份赢（LWW）：
 * 复习进度这种东西，谁最后复习就听谁的。墓碑更新时间晚于卡片改动时，
 * 删除赢（说明删完之后没有在别处再改它）。
 */
function mergeDeckPair(local: Deck, remote: Deck, deleted: DeckTombstones): Deck {
  const deckLast = Math.max(deckTime(local), deckTime(remote));
  const nameSource = deckTime(local) >= deckTime(remote) ? local : remote;

  const lMap = new Map(local.cards.map((card) => [card.id, card] as const));
  const rMap = new Map(remote.cards.map((card) => [card.id, card] as const));
  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const id of [...lMap.keys(), ...rMap.keys()]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const l = lMap.get(id);
    const r = rMap.get(id);
    const winner = l && r ? (cardTime(l) >= cardTime(r) ? l : r) : ((l ?? r) as Card);
    const at = deleted.cards[id];
    if (at !== undefined && at > cardTime(winner)) continue;
    cards.push(winner);
  }

  return {
    id: local.id,
    name: nameSource.name,
    // 创建时间两边必然一样（同一个 id 只在创建它的设备上生成）；取小值兜底
    createdAt: Math.min(local.createdAt, remote.createdAt),
    rounds: Math.max(local.rounds, remote.rounds),
    updatedAt: deckLast,
    cards,
  };
}

function mergeDeckLists(local: Deck[], remote: Deck[], deleted: DeckTombstones): Deck[] {
  const lMap = new Map(local.map((deck) => [deck.id, deck] as const));
  const rMap = new Map(remote.map((deck) => [deck.id, deck] as const));
  const out: Deck[] = [];

  for (const id of new Set([...lMap.keys(), ...rMap.keys()])) {
    const l = lMap.get(id);
    const r = rMap.get(id);
    const deletedAt = deleted.decks[id];
    if (l && r) {
      // 两边都有：除非删除时间比两边都晚（都删干净了），否则合并
      if (deletedAt !== undefined && deletedAt > Math.max(deckTime(l), deckTime(r))) continue;
      out.push(mergeDeckPair(l, r, deleted));
    } else {
      const deck = (l ?? r) as Deck;
      if (deletedAt !== undefined && deletedAt > deckTime(deck)) continue;
      out.push(keepLiveCards(deck, deleted.cards));
    }
  }

  // 与应用的展示顺序一致：新卡组在前；创建时间相同则按 id 兜底，保证两台设备一致
  out.sort((a, b) => b.createdAt - a.createdAt || byId(a, b));
  return out;
}

export interface EnvelopeMerge {
  /** 合并之后的卡组 */
  decks: Deck[];
  /** 合并之后的墓碑 */
  deleted: DeckTombstones;
  /** 内容变没变（变了才需要写回内存 / 落盘 / 再推） */
  dataChanged: boolean;
  tombstonesChanged: boolean;
  /** 被墓碑按下去的卡组条数，用来在界面上说人话 */
  removed: number;
}

/**
 * 把远端信封合进本地信封。
 *
 * 顺序很要紧：
 *   1. 先把两份卡组**求并集**（id 去重、updatedAt 较新者胜、卡片逐张合并）
 *   2. 再把墓碑**并起来**（两台设备各删各的，一条都不能丢）
 *   3. 最后让墓碑去按 —— **这一步必须在并集之后**。反过来的话，
 *      远端删掉的东西会先被墓碑按掉，接着又被并集当成「本地有、远端没有」
 *      加回来，删除就白删了。
 */
export function mergeEnvelopes(local: CloudEnvelope, remote: CloudEnvelope): EnvelopeMerge {
  const deleted = mergeTombstones(local.deleted, remote.deleted);
  const decks = mergeDeckLists(local.decks, remote.decks, deleted);
  const pruned = pruneTombstones(deleted, decks);

  const localIds = new Set(local.decks.map((deck) => deck.id));
  const mergedIds = new Set(decks.map((deck) => deck.id));
  let removed = 0;
  for (const id of localIds) {
    if (!mergedIds.has(id)) removed += 1;
  }

  return {
    decks,
    deleted: pruned,
    dataChanged: !sameDecksContent(decks, local.decks),
    tombstonesChanged: !sameTombstones(pruned, local.deleted),
    removed,
  };
}

/**
 * 这份数据里有没有**卡片**。
 *
 * 判断「要不要问用户用哪边」用的就是它（见 cloud.ts）。只看卡片、不看卡组：
 * 新建的空卡组对用户来说就是「还没录东西」，不该拿「这台设备 vs 云端」
 * 这种二选一来吓他一下；而且这时候合并本来就没有可丢的东西。
 */
export function hasAnyCards(decks: Deck[]): boolean {
  return decks.some((deck) => deck.cards.length > 0);
}
