import { describe, expect, it } from "vitest";
import { buildPrompt, parseCards, salvageCards } from "./cards.mjs";

describe("AI card output parsing", () => {
  it("parses fenced JSON and preserves cloze syntax", () => {
    const cards = parseCards('```json\n{"cards":[{"front":"{{c1::AllPredecessor}} waits for all inputs","back":"Wait for every predecessor"}]}\n```');

    expect(cards).toEqual([{ front: "{{c1::AllPredecessor}} waits for all inputs", back: "Wait for every predecessor", section: "未分类" }]);
  });

  it("extracts the first complete object from surrounding text", () => {
    const cards = parseCards('Result:\n{"cards":[{"front":"Redis write failure policy?","back":"Best effort"}]}\nDone');

    expect(cards).toHaveLength(1);
    expect(cards[0].back).toBe("Best effort");
  });

  it("reports truncated JSON in actionable terms", () => {
    expect(() => parseCards('{"cards":[{"front":"unfinished')).toThrow("模型返回内容不完整");
  });
});

describe("knowledge-focused card prompts", () => {
  it("asks for one or two related blanks and excludes meta text", () => {
    const prompt = buildPrompt({ kind: "cloze", density: "多", text: "一段有关节点触发规则的材料。" });

    expect(prompt).toContain("同一知识点可以挖 1-2 个相互关联的关键词");
    expect(prompt).toContain("不要按句子机械地逐句挖空");
    expect(prompt).toContain("来源声明");
    expect(prompt).not.toContain("生成 6 到 18 张");
    expect(prompt).toContain("填写 section");
    expect(prompt).toContain("最多 3 句");
  });

  it("keeps the section returned for each AI card", () => {
    const cards = parseCards('{"cards":[{"section":"二、节点划分","front":"ChatTemplate 是什么？","back":"唯一汇合点"}]}');

    expect(cards[0].section).toBe("二、节点划分");
  });

  it("asks question cards to answer within three sentences", () => {
    const prompt = buildPrompt({ kind: "qa", density: "少", text: "一段材料。" });

    expect(prompt).toContain("最多 3 句");
  });
});

describe("salvaging cards from truncated model output", () => {
  it("keeps every complete card before the cut", () => {
    const cards = salvageCards('{"cards":[{"section":"一","front":"{{c1::甲}} 的定义","back":"甲"},{"section":"二","front":"乙是什么","back":"乙"},{"section":"三","front":"丙');

    expect(cards).toEqual([
      { front: "{{c1::甲}} 的定义", back: "甲", section: "一" },
      { front: "乙是什么", back: "乙", section: "二" },
    ]);
  });

  it("does not trip over braces inside card text", () => {
    const cards = salvageCards('{"cards":[{"front":"用 {} 表示空集合","back":"空集合"}],"finish');

    expect(cards).toEqual([{ front: "用 {} 表示空集合", back: "空集合", section: "未分类" }]);
  });

  it("returns nothing when the cut happens before any card closes", () => {
    expect(salvageCards('{"cards":[{"front":"半张')).toEqual([]);
  });
});
