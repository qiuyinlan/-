import { describe, expect, it } from "vitest";
import {
  advanceEbbinghaus, Card, countBlanks, MAX_CARD_CHARS, mergeIntoContextCards, nextRoundCardIndex, oneClickCloze,
} from "./study";

describe("round review skips", () => {
  const card = (id: string, reviewSkipRound?: number): Card => ({ id, kind: "qa", front: id, back: id, roundSeen: 0, stage: 0, dueAt: 0, reviewSkipRound });
  const deck = { id: "deck", name: "deck", createdAt: 0, rounds: 2, cards: [card("a", 3), card("b"), card("c", 3)] };

  it("skips reviewed cards throughout the current round", () => {
    expect(nextRoundCardIndex(deck)).toBe(1);
    expect(nextRoundCardIndex(deck, 2)).toBe(-1);
    expect(nextRoundCardIndex({ ...deck, cards: [card("a", 3)] })).toBe(-1);
  });

  it("shows those cards again in the next round", () => {
    expect(nextRoundCardIndex({ ...deck, rounds: 3 })).toBe(0);
  });
});

describe("one-click cloze generation", () => {
  const text = "有效复习是学习的重要方法，复习间隔以1天、2天为宜。";

  it("creates cloze cards at low and high density", () => {
    const few = oneClickCloze(text, "少");
    const more = oneClickCloze(text, "多");

    expect(few).toHaveLength(1);
    expect(more).toHaveLength(1);
    expect(few[0].front.match(/\{\{c\d+::/g)).toHaveLength(1);
    expect(more[0].front.match(/\{\{c\d+::/g)).toHaveLength(2);
    expect(more[0].back.split("、")).toHaveLength(2);
  });

  it("returns no cards for text without usable sentences", () => {
    expect(oneClickCloze("太短。", "少")).toEqual([]);
  });

  it("assigns Markdown section headings to generated cards", () => {
    const cards = oneClickCloze("## 一、链路形态\nKnowledgeRetriever 是知识检索节点，负责从知识库拿到相关文档。\n\n## 二、节点划分\nChatTemplate 是唯一汇合点。", "少");

    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].section).toBe("一、链路形态");
    expect(cards.at(-1)?.section).toBe("二、节点划分");
  });
});

describe("card context width", () => {
  const line = "Pilot 是 Go 实现的 Agent。它把排障和检索统一起来。调用真实的 Prometheus 数据源。最后给出可执行的排查建议。";
  const plain = (front: string) => front.replace(/\{\{c\d+::([^}]*)\}\}/g, "$1");

  it("packs up to three sentences of context into one card", () => {
    const cards = oneClickCloze(line, "少");

    expect(cards).toHaveLength(2);
    expect(plain(cards[0].front)).toContain("Pilot 是 Go 实现的 Agent。");
    expect(plain(cards[0].front)).toContain("调用真实的 Prometheus 数据源。");
    expect(plain(cards[0].front)).not.toContain("最后给出可执行的排查建议。");
    expect(plain(cards[1].front)).toBe("最后给出可执行的排查建议。");
  });

  it("keeps a single blank per card at low density", () => {
    const [card] = oneClickCloze(line, "少");

    expect(card.front.match(/\{\{c\d+::/g)).toHaveLength(1);
  });

  it("applies high density inside a multi-sentence card", () => {
    const [card] = oneClickCloze("「指数退避」和「死信队列」是消息队列的两道防线。它避免压垮下游服务。重试到上限后进入死信队列。", "多");

    expect(plain(card.front)).toContain("它避免压垮下游服务。");
    expect(card.front.match(/\{\{c\d+::/g)).toHaveLength(2);
  });

  it("stops packing sentences once the card gets long", () => {
    const sentence = (index: number) => `第${index}段：消息队列在消费者处理失败时会把消息重新投递到重试队列并记录失败次数，超过阈值后进入死信队列等待人工处理，同时触发告警通知值班同学查看并补充完整上下文，排查时优先对比消息轨迹与消费位点确认是否重复投递。`;
    const cards = oneClickCloze(`${sentence(1)}${sentence(2)}${sentence(3)}`, "多");

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(plain(card.front).length).toBeLessThanOrEqual(MAX_CARD_CHARS);
    }
  });
});

describe("merging cards into context-rich cards", () => {
  const make = (index: number, front: string, back: string, extra: Partial<Card> = {}): Card => ({
    id: `c${index}`, kind: "cloze", front, back, section: "一节",
    roundSeen: 0, stage: 0, dueAt: 1000 + index, ...extra,
  });

  it("joins three single-sentence cards and renumbers their blanks", () => {
    const cards = [
      make(1, "甲{{c1::一}}是函数。", "一"),
      make(2, "乙{{c1::二}}是对象。", "二"),
      make(3, "丙{{c1::三}}是数组。", "三"),
    ];

    const merged = mergeIntoContextCards(cards, 3);

    expect(merged).toHaveLength(1);
    expect(merged[0].front).toBe("甲{{c1::一}}是函数。乙{{c2::二}}是对象。丙{{c3::三}}是数组。");
    expect(countBlanks(merged[0].front)).toBe(3);
    expect(merged[0].back).toBe("一；二；三");
    expect(merged[0].id).toBe("c1");
    expect(merged[0].section).toBe("一节");
  });

  it("starts a new card once the sentence budget is used up", () => {
    const cards = [
      make(1, "甲{{c1::一}}。", "一"),
      make(2, "乙{{c1::二}}。", "二"),
      make(3, "丙{{c1::三}}。", "三"),
      make(4, "丁{{c1::四}}。", "四"),
    ];

    const merged = mergeIntoContextCards(cards, 3);

    expect(merged.map((card) => countBlanks(card.front))).toEqual([3, 1]);
  });

  it("never merges across a question card", () => {
    const cards = [
      make(1, "甲{{c1::一}}。", "一"),
      { ...make(9, "为什么？", "因为。"), kind: "qa" as const },
      make(2, "乙{{c1::二}}。", "二"),
    ];

    const merged = mergeIntoContextCards(cards, 3);

    expect(merged).toHaveLength(3);
    expect(merged[1].kind).toBe("qa");
  });

  it("keeps the earliest review state of the merged cards", () => {
    const cards = [
      make(1, "甲{{c1::一}}。", "一", { dueAt: 9000, stage: 2, roundSeen: 3 }),
      make(2, "乙{{c1::二}}。", "二", { dueAt: 5000, stage: 0, roundSeen: 1, lastReviewed: 4000 }),
    ];

    const [card] = mergeIntoContextCards(cards, 3);

    expect(card.dueAt).toBe(5000);
    expect(card.stage).toBe(0);
    expect(card.roundSeen).toBe(1);
    expect(card.lastReviewed).toBe(4000);
  });

  it("leaves cards already at the sentence limit untouched", () => {
    const cards = [make(1, "甲{{c1::一}}。乙{{c2::二}}。丙{{c3::三}}。", "一二三"), make(2, "丁{{c1::四}}。戊{{c2::五}}。", "四五")];

    expect(mergeIntoContextCards(cards, 3)).toHaveLength(2);
  });
});

describe("Ebbinghaus review scheduling", () => {
  const card: Card = {
    id: "card-1", kind: "qa", front: "问题", back: "答案", roundSeen: 0,
    stage: 0, dueAt: 0,
  };
  const day = 86_400_000;

  it("advances the next due date through the review intervals", () => {
    const now = 1000;
    const first = advanceEbbinghaus(card, true, now);
    const second = advanceEbbinghaus(first, true, now);

    expect(first.stage).toBe(1);
    expect(first.dueAt).toBe(now + day);
    expect(second.stage).toBe(2);
    expect(second.dueAt).toBe(now + 2 * day);
  });

  it("resets the interval when a card is forgotten", () => {
    const advanced = { ...card, stage: 5 };
    const result = advanceEbbinghaus(advanced, false, 1000);

    expect(result.stage).toBe(0);
    expect(result.dueAt).toBe(1000 + day);
  });
});

