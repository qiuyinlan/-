/**
 * 云端同步 · 纯逻辑测试（信封、合并规则、删除墓碑、两台设备收敛）。
 *
 * 照「断舍离」tests/cloud.ts 的测法改造：不碰网络，只钉几条底线：
 *   1. 合并**只做加法** —— 两边的东西合完都得在
 *   2. 删除要**传得过去**，但不能把「删完之后又改过」的改动一起抹掉
 *   3. 两台设备来回同步之后必须**收敛**，而且再同步一次不再发生变化
 *   4. 远端形状不对时**绝不合并**，宁可报错
 */

import { describe, expect, it } from "vitest";
import type { Card, Deck } from "./study";
import {
  TOMBSTONE_TTL_DAYS,
  type CloudEnvelope,
  checkEnvelope,
  collectDeckRemovals,
  emptyTombstones,
  hasAnyCards,
  makeEnvelope,
  mergeEnvelopes,
  mergeTombstones,
  pruneTombstones,
  sameDecksContent,
  sameEnvelopeContent,
} from "./cloudMerge";

/* ------------------------------------------------------------------ */
/* 夹具：时间全部相对今天算                                             */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.now();
const T0 = NOW - 3 * DAY_MS; // 创建时间
const T1 = NOW - 2 * DAY_MS; // 旧改动
const T2 = NOW - 1 * DAY_MS; // 新改动

function card(id: string, updatedAt: number, extra: Partial<Card> = {}): Card {
  return {
    id,
    kind: "cloze",
    front: `正面-${id}`,
    back: `答案-${id}`,
    section: "一节",
    roundSeen: 0,
    stage: 0,
    dueAt: T0,
    updatedAt,
    ...extra,
  };
}

function deck(id: string, cards: Card[], updatedAt: number, extra: Partial<Deck> = {}): Deck {
  return { id, name: `卡组-${id}`, createdAt: T0, cards, rounds: 0, updatedAt, ...extra };
}

function envelope(decks: Deck[], deleted = emptyTombstones(), deviceId = "dev-test"): CloudEnvelope {
  return makeEnvelope(decks, deleted, deviceId, new Date(T0).toISOString());
}

function base(): Deck[] {
  // 卡组 d1 两张卡，卡组 d2 一张卡 —— 覆盖「多卡组」和「有卡没卡」两种形状
  return [
    deck("d1", [card("c1", T0), card("c2", T0)], T0),
    deck("d2", [card("c3", T0)], T0),
  ];
}

function withoutCard(decks: Deck[], deckId: string, cardId: string): Deck[] {
  return decks.map((item) => (item.id === deckId ? { ...item, cards: item.cards.filter((c) => c.id !== cardId) } : item));
}

/* ------------------------------------------------------------------ */
/* 信封本身                                                            */
/* ------------------------------------------------------------------ */

describe("云端同步 · 信封与校验", () => {
  it("形状不对的远端数据一律拒绝（本地那份不能拿去合）", () => {
    expect(checkEnvelope(null).ok).toBe(false);
    expect(checkEnvelope([]).ok).toBe(false);
    expect(checkEnvelope("随便一段字符串").ok).toBe(false);
    expect(checkEnvelope({}).ok).toBe(false);

    // 信封格式版本比自己高：以后加了字段，老程序读不懂
    expect(checkEnvelope({ v: 2, schemaVersion: 1, decks: base(), deleted: {} }).reason).toBe("versionTooNew");

    // 数据结构版本比自己高：老程序明确拒绝，不静默丢字段
    expect(checkEnvelope({ v: 1, schemaVersion: 99, decks: base(), deleted: {} }).reason).toBe("badSchema");

    // decks 不是数组
    expect(checkEnvelope({ v: 1, schemaVersion: 1, decks: "oops", deleted: {} }).reason).toBe("badData");

    // 卡组里少了 cards 数组
    expect(checkEnvelope({ v: 1, schemaVersion: 1, decks: [{ id: "x", name: "y" }], deleted: {} }).reason).toBe("badData");

    // 墓碑的时间不是数字
    expect(
      checkEnvelope({ v: 1, schemaVersion: 1, decks: [], deleted: { decks: { d1: "abc" }, cards: {} } }).reason,
    ).toBe("badDeleted");

    expect(checkEnvelope(envelope(base())).ok).toBe(true);
  });

  it("认得出「这台设备还没录东西」（首次同步靠它决定要不要问用户）", () => {
    // 只有空卡组：对用户来说就是还没录东西
    expect(hasAnyCards([deck("empty", [], T0)])).toBe(false);
    expect(hasAnyCards(base())).toBe(true);
  });

  it("内容比对忽略 updatedAt（否则每合并一次都算「变了」）", () => {
    const a = base();
    const b = a.map((item) => ({ ...item, updatedAt: T2 }));
    expect(sameDecksContent(a, b)).toBe(true);

    const c = withoutCard(base(), "d1", "c1");
    expect(sameDecksContent(a, c)).toBe(false);
  });

  it("集合的先后不同不算「变了」（否则两台设备会互推个没完）", () => {
    const a = base();
    const reordered: Deck[] = [a[1], a[0]].map((item) => ({ ...item, cards: [...item.cards].reverse() }));
    expect(sameDecksContent(a, reordered)).toBe(true);

    const renamed = a.map((item) => (item.id === "d1" ? { ...item, name: "改过名" } : item));
    expect(sameDecksContent(a, renamed)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 删除墓碑                                                            */
/* ------------------------------------------------------------------ */

describe("云端同步 · 删除要传得过去，改动不能白改", () => {
  it("A 删掉一个卡组，合并到 B 那边也不见了", () => {
    const a = envelope(base().filter((item) => item.id !== "d1"), { decks: { d1: T1 }, cards: {} }, "dev-a");
    const b = envelope(base(), emptyTombstones(), "dev-b");

    const merged = mergeEnvelopes(b, a);
    expect(merged.decks.map((item) => item.id)).toEqual(["d2"]);
    expect(merged.removed).toBe(1);
  });

  it("A 删掉一张卡片，合并到 B 那边也不见了", () => {
    const a = envelope(withoutCard(base(), "d1", "c1"), { decks: {}, cards: { c1: T1 } }, "dev-a");
    const b = envelope(base(), emptyTombstones(), "dev-b");

    const merged = mergeEnvelopes(b, a);
    const d1 = merged.decks.find((item) => item.id === "d1");
    expect(d1?.cards.map((item) => item.id)).toEqual(["c2"]);
    expect(merged.removed).toBe(0);
  });

  it("删掉之后又在另一台设备上改过 → 改动赢，不许静默抹掉", () => {
    // B 上 d1 被改到 T2（晚于 A 的删除时间 T1）
    const edited = base().map((item) => (item.id === "d1" ? { ...item, name: "改过的卡组", updatedAt: T2 } : item));
    const a = envelope(base().filter((item) => item.id !== "d1"), { decks: { d1: T1 }, cards: {} }, "dev-a");
    const b = envelope(edited, emptyTombstones(), "dev-b");

    const merged = mergeEnvelopes(b, a);
    const kept = merged.decks.find((item) => item.id === "d1");
    expect(kept, "改动时间比删除时间新 —— 这个卡组必须留下").toBeTruthy();
    expect(kept?.name).toBe("改过的卡组");
  });

  it("卡片删完之后又复习过 → 复习进度赢", () => {
    // A 在 T1 删了 c1；B 在 T2 复习了 c1（卡片 updatedAt = T2）
    const edited = base().map((item) => (item.id === "d1" ? { ...item, cards: [card("c1", T2, { stage: 3 }), item.cards[1]] } : item));
    const a = envelope(withoutCard(base(), "d1", "c1"), { decks: {}, cards: { c1: T1 } }, "dev-a");
    const b = envelope(edited, emptyTombstones(), "dev-b");

    const merged = mergeEnvelopes(b, a);
    const d1 = merged.decks.find((item) => item.id === "d1");
    expect(d1?.cards.find((item) => item.id === "c1")?.stage).toBe(3);
  });

  it("两台设备各删各的，两边都要作数", () => {
    const a = envelope(base().filter((item) => item.id !== "d1"), { decks: { d1: T1 }, cards: {} }, "dev-a");
    const b = envelope(base().filter((item) => item.id !== "d2"), { decks: { d2: T2 }, cards: {} }, "dev-b");

    const merged = mergeEnvelopes(a, b);
    expect(merged.deleted.decks.d1).toBe(T1);
    expect(merged.deleted.decks.d2).toBe(T2);
    expect(merged.decks).toHaveLength(0);
  });

  it("删除记录不会无限堆着（老墓碑会过期）", () => {
    const old = NOW - (TOMBSTONE_TTL_DAYS + 1) * DAY_MS;
    const kept = pruneTombstones({ decks: { gone: old, recent: T2 }, cards: {} }, base());
    expect(kept.decks.gone).toBeUndefined();
    expect(kept.decks.recent).toBe(T2);
  });

  it("记录复活之后，那条墓碑自动作废", () => {
    const data = base().map((item) => (item.id === "d1" ? { ...item, updatedAt: T2 } : item));
    const left = pruneTombstones({ decks: { d1: T1 }, cards: {} }, data);
    expect(left.decks.d1).toBeUndefined();
  });

  it("本机删除会被记成墓碑（比对前后两份数据的差）", () => {
    const before = base();
    const after = withoutCard(base(), "d1", "c1");
    const removals = collectDeckRemovals(before, after, T1);
    expect(removals.cards.c1).toBe(T1);
    expect(Object.keys(removals.decks)).toHaveLength(0);
    expect(Object.keys(removals.cards)).toHaveLength(1);

    // 只是改个名字 —— 一条墓碑都不该产生
    const renamed = before.map((item) => (item.id === "d1" ? { ...item, name: "改名了" } : item));
    const renames = collectDeckRemovals(before, renamed, T1);
    expect(Object.keys(renames.decks)).toHaveLength(0);
    expect(Object.keys(renames.cards)).toHaveLength(0);
  });

  it("墓碑取两边的并集，同一个 id 保留更晚的删除时间", () => {
    const merged = mergeTombstones({ decks: { d1: T1 }, cards: { c1: T1 } }, { decks: { d1: T2, d2: T2 }, cards: {} });
    expect(merged.decks.d1).toBe(T2);
    expect(merged.decks.d2).toBe(T2);
    expect(merged.cards.c1).toBe(T1);
  });
});

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

describe("云端同步 · 合并规则", () => {
  it("合并只做加法：两台设备各自录的东西合完都在", () => {
    const aDecks = [...base(), deck("a-new", [card("ca", T2)], T2)];
    const bDecks = [...base(), deck("b-new", [card("cb", T2)], T2)];
    const a = envelope(aDecks, emptyTombstones(), "dev-a");
    const b = envelope(bDecks, emptyTombstones(), "dev-b");

    const merged = mergeEnvelopes(a, b);
    const ids = merged.decks.map((item) => item.id).sort();
    expect(ids).toEqual(["a-new", "b-new", "d1", "d2"]);
  });

  it("同一个卡组两边都改过 → 名字按 updatedAt 较新的那份", () => {
    const older = base().map((item) => (item.id === "d1" ? { ...item, name: "旧的改动", updatedAt: T1 } : item));
    const newer = base().map((item) => (item.id === "d1" ? { ...item, name: "新的改动", updatedAt: T2 } : item));
    const merged = mergeEnvelopes(envelope(older, emptyTombstones(), "dev-a"), envelope(newer, emptyTombstones(), "dev-b"));
    expect(merged.decks.find((item) => item.id === "d1")?.name).toBe("新的改动");
  });

  it("同一张卡片两边都复习过 → 进度按 updatedAt 较新的那份（LWW）", () => {
    const older = base().map((item) =>
      item.id === "d1" ? { ...item, cards: [card("c1", T1, { stage: 1, dueAt: T1 }), item.cards[1]] } : item,
    );
    const newer = base().map((item) =>
      item.id === "d1" ? { ...item, cards: [card("c1", T2, { stage: 4, dueAt: T2 }), item.cards[1]] } : item,
    );
    const merged = mergeEnvelopes(envelope(older, emptyTombstones(), "dev-a"), envelope(newer, emptyTombstones(), "dev-b"));
    const c1 = merged.decks.find((item) => item.id === "d1")?.cards.find((item) => item.id === "c1");
    expect(c1?.stage).toBe(4);
    expect(c1?.dueAt).toBe(T2);
  });

  it("卡组轮次取两边较大值，创建时间取较小值", () => {
    const a = envelope([deck("d1", [card("c1", T0)], T0, { rounds: 3 })], emptyTombstones(), "dev-a");
    const b = envelope([deck("d1", [card("c1", T0)], T0, { rounds: 5 })], emptyTombstones(), "dev-b");
    const merged = mergeEnvelopes(a, b);
    expect(merged.decks[0].rounds).toBe(5);
    expect(merged.decks[0].createdAt).toBe(T0);
  });

  it("合并结果按创建时间从新到旧排（和应用展示顺序一致）", () => {
    const a = envelope([deck("d1", [card("c1", T0)], T0)], emptyTombstones(), "dev-a");
    const b = envelope([deck("d2", [card("c2", T2)], T2, { createdAt: T2 })], emptyTombstones(), "dev-b");
    const merged = mergeEnvelopes(a, b);
    expect(merged.decks.map((item) => item.id)).toEqual(["d2", "d1"]);
  });
});

/* ------------------------------------------------------------------ */
/* 两台设备的收敛（端到端模拟）                                        */
/* ------------------------------------------------------------------ */

/**
 * 用一个假服务端把「两台设备 + 一份云端」跑起来。
 *
 * 照着 cloud.ts 里 runSync / reconcile 的顺序走：先合并、再落地、最后推。
 * 这样测的是「顺序对不对」，而不是某个函数单看对不对 —— 同步的错基本
 * 都错在顺序上。
 */
interface FakeServer {
  env: CloudEnvelope | null;
  rev: number;
}

interface FakeDevice {
  name: string;
  env: CloudEnvelope;
  /** 一共往上推了几次 —— 用来测「收敛之后不该再推」 */
  pushes: number;
}

function device(name: string, decks: Deck[]): FakeDevice {
  return { name, env: envelope(decks, emptyTombstones(), name), pushes: 0 };
}

/** 本机改数据（含删除）—— 和 cloud.ts 里 decks 变化后上报走同一套函数 */
function editLocal(dev: FakeDevice, mutate: (decks: Deck[]) => Deck[], at: number): void {
  const next = mutate(dev.env.decks);
  const removals = collectDeckRemovals(dev.env.decks, next, at);
  dev.env = {
    ...dev.env,
    decks: next,
    deleted: mergeTombstones(dev.env.deleted, removals),
    savedAt: new Date(at).toISOString(),
  };
}

function syncDevice(dev: FakeDevice, server: FakeServer): void {
  if (server.env === null) {
    server.rev = 1;
    server.env = dev.env;
    dev.pushes += 1;
    return;
  }
  const merged = mergeEnvelopes(dev.env, server.env);
  dev.env = makeEnvelope(merged.decks, merged.deleted, dev.name, dev.env.savedAt);
  if (!sameEnvelopeContent(dev.env, server.env)) {
    server.rev += 1;
    server.env = dev.env;
    dev.pushes += 1;
  }
}

describe("云端同步 · 两台设备收敛（端到端）", () => {
  it("电脑删掉一个卡组 → 手机同步之后它也不见了", () => {
    const server: FakeServer = { env: null, rev: 0 };
    const pc = device("pc", base());
    const phone = device("phone", base());

    syncDevice(pc, server); // 电脑先上去
    syncDevice(phone, server); // 手机接上

    editLocal(pc, (decks) => decks.filter((item) => item.id !== "d1"), T1);
    syncDevice(pc, server);
    syncDevice(phone, server);

    expect(phone.env.decks.map((item) => item.id)).toEqual(["d2"]);
    expect(server.env?.decks.map((item) => item.id)).toEqual(["d2"]);
  });

  it("两边离线各改各的 → 同步之后谁的东西都没丢", () => {
    const server: FakeServer = { env: null, rev: 0 };
    const pc = device("pc", base());
    const phone = device("phone", base());
    syncDevice(pc, server);
    syncDevice(phone, server);

    // 电脑：改了 d1 的名字，又加了一个卡组
    editLocal(
      pc,
      (decks) => [
        ...decks.map((item) => (item.id === "d1" ? { ...item, name: "电脑改的", updatedAt: T1 } : item)),
        deck("pc-new", [card("cpc", T1)], T1),
      ],
      T1,
    );
    // 手机：加了一张新卡片到 d2
    editLocal(
      phone,
      (decks) => decks.map((item) => (item.id === "d2" ? { ...item, updatedAt: T2, cards: [...item.cards, card("cph", T2)] } : item)),
      T2,
    );

    syncDevice(pc, server);
    syncDevice(phone, server);
    syncDevice(pc, server);

    const ids = pc.env.decks.map((item) => item.id).sort();
    expect(ids).toEqual(["d1", "d2", "pc-new"]);
    expect(phone.env.decks.find((item) => item.id === "d1")?.name).toBe("电脑改的");
    expect(phone.env.decks.find((item) => item.id === "d2")?.cards.map((item) => item.id)).toEqual(["c3", "cph"]);
    expect(sameDecksContent(pc.env.decks, phone.env.decks)).toBe(true);
    expect(sameDecksContent(pc.env.decks, server.env!.decks)).toBe(true);

    // 再来回同步几轮：不该再有任何推送（顺序差异不能让它一直推）
    const revAfter = server.rev;
    const pushesAfter = pc.pushes + phone.pushes;
    syncDevice(pc, server);
    syncDevice(phone, server);
    syncDevice(pc, server);
    syncDevice(phone, server);
    expect(server.rev).toBe(revAfter);
    expect(pc.pushes + phone.pushes).toBe(pushesAfter);
  });

  it("一边新增、一边删除同时发生 → 新增留下、删除也生效", () => {
    const server: FakeServer = { env: null, rev: 0 };
    const pc = device("pc", base());
    const phone = device("phone", base());
    syncDevice(pc, server);
    syncDevice(phone, server);

    editLocal(pc, (decks) => decks.filter((item) => item.id !== "d1"), T1);
    editLocal(phone, (decks) => [...decks, deck("ph-new", [card("cph", T2)], T2)], T2);

    syncDevice(phone, server);
    syncDevice(pc, server);
    syncDevice(phone, server);

    expect(pc.env.decks.map((item) => item.id).sort()).toEqual(["d2", "ph-new"]);
    expect(sameDecksContent(pc.env.decks, phone.env.decks)).toBe(true);
  });

  it("墓碑本身也要同步 —— 第三台设备接上时删除依然有效", () => {
    const server: FakeServer = { env: null, rev: 0 };
    const pc = device("pc", base());
    syncDevice(pc, server);

    editLocal(pc, (decks) => decks.filter((item) => item.id !== "d1"), T1);
    syncDevice(pc, server);

    // 现在来了一台从没同步过的设备（本地还带着 d1）
    const tablet = device("tablet", base());
    syncDevice(tablet, server);

    expect(tablet.env.decks.map((item) => item.id)).toEqual(["d2"]);
    expect(tablet.env.deleted.decks.d1).toBeDefined();
  });
});
