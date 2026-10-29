import { describe, expect, it } from "vitest";
import type { Card, Deck } from "./study";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  createBackup,
  mergeBackupDecks,
  parseBackup,
} from "./backup";

const NOW = 1_000_000;

function card(id: string, updatedAt: number, extra: Partial<Card> = {}): Card {
  return {
    id,
    kind: "cloze",
    front: `正面-${id}`,
    back: `答案-${id}`,
    section: "一节",
    roundSeen: 0,
    stage: 0,
    dueAt: NOW,
    updatedAt,
    ...extra,
  };
}

function deck(id: string, cards: Card[], updatedAt: number, extra: Partial<Deck> = {}): Deck {
  return { id, name: `卡组-${id}`, createdAt: updatedAt, cards, rounds: 0, updatedAt, ...extra };
}

describe("备份 · 导出", () => {
  it("导出是可解析的 JSON，带格式标记和卡组数据", () => {
    const decks = [deck("d1", [card("c1", NOW)], NOW)];
    const text = createBackup(decks, NOW);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.exportedAt).toBe(new Date(NOW).toISOString());
    expect(Array.isArray(parsed.decks)).toBe(true);
    expect((parsed.decks as Deck[])[0].id).toBe("d1");
  });

  it("导出的内容能原样导回来", () => {
    const decks = [deck("d1", [card("c1", NOW, { stage: 3 }), card("c2", NOW)], NOW, { rounds: 2 })];
    const restored = parseBackup(createBackup(decks, NOW)).decks;
    expect(restored).toHaveLength(1);
    expect(restored[0].rounds).toBe(2);
    expect(restored[0].cards.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(restored[0].cards[0].stage).toBe(3);
  });
});

describe("备份 · 解析与校验", () => {
  it("兼容旧格式：{ decks } 对象和裸数组", () => {
    expect(parseBackup('{"decks":[]}').decks).toEqual([]);
    expect(parseBackup("[]").decks).toEqual([]);
    const legacy = JSON.stringify({ decks: [{ id: "d1", name: "旧卡组", cards: [{ id: "c1", front: "问", back: "答" }] }] });
    const parsed = parseBackup(legacy);
    expect(parsed.decks[0].name).toBe("旧卡组");
    expect(parsed.decks[0].cards[0].kind).toBe("cloze");
    expect(parsed.decks[0].rounds).toBe(0);
  });

  it("开头带 BOM 也能读", () => {
    const text = `\uFEFF${JSON.stringify({ decks: [] })}`;
    expect(parseBackup(text).decks).toEqual([]);
  });

  it("不是 JSON / 没有 decks 都明确报错", () => {
    expect(() => parseBackup("随便一段不是 JSON 的文字")).toThrow("不是有效的 JSON 文件");
    expect(() => parseBackup('{"hello":1}')).toThrow("没有找到卡组数据");
    expect(() => parseBackup('{"decks":"oops"}')).toThrow("没有找到卡组数据");
  });

  it("卡组/卡片结构不对时拒绝，不硬塞", () => {
    expect(() => parseBackup('{"decks":[{"id":"d1"}]}')).toThrow("缺少卡片列表");
    expect(() =>
      parseBackup(JSON.stringify({ decks: [{ id: "d1", cards: [{ id: "c1", front: "问" }] }] })),
    ).toThrow("缺少答案内容");
    expect(() =>
      parseBackup(JSON.stringify({ decks: [{ id: "d1", cards: [{ id: "c1", front: "", back: "答" }] }] })),
    ).toThrow("缺少正面内容");
  });
});

describe("备份 · 合并导入（只做加法）", () => {
  it("本机没有的卡组原样追加，总共一个不少", () => {
    const local = [deck("d1", [card("c1", NOW)], NOW)];
    const incoming = [deck("d2", [card("c2", NOW + 1)], NOW + 1)];
    const merged = mergeBackupDecks(local, incoming);
    expect(merged.map((item) => item.id).sort()).toEqual(["d1", "d2"]);
  });

  it("同名卡组（同 id）按较新的数据合并，轮次取较大值", () => {
    const local = deck("d1", [card("c1", NOW, { stage: 0 })], NOW, { rounds: 1 });
    const incoming = deck("d1", [card("c1", NOW + 1, { stage: 4 })], NOW + 1, { rounds: 3 });
    const [merged] = mergeBackupDecks([local], [incoming]);
    expect(merged.cards[0].stage).toBe(4);
    expect(merged.rounds).toBe(3);
    expect(merged.createdAt).toBe(NOW);
  });

  it("同一张卡两边都有：较新的复习进度赢；时间相同时保留本机", () => {
    const local = deck("d1", [card("c1", NOW, { stage: 2 })], NOW);
    const newer = deck("d1", [card("c1", NOW + 5, { stage: 5 })], NOW);
    expect(mergeBackupDecks([local], [newer])[0].cards[0].stage).toBe(5);

    const tie = deck("d1", [card("c1", NOW, { stage: 9 })], NOW);
    expect(mergeBackupDecks([local], [tie])[0].cards[0].stage).toBe(2);
  });

  it("合并结果按创建时间从新到旧排", () => {
    const local = [deck("d1", [card("c1", NOW)], NOW)];
    const incoming = [deck("d2", [card("c2", NOW + 10)], NOW + 10, { createdAt: NOW + 10 })];
    expect(mergeBackupDecks(local, incoming).map((item) => item.id)).toEqual(["d2", "d1"]);
  });
});
