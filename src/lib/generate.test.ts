import { describe, expect, it } from "vitest";
import { classifyFailure, generateCards, GenerateError, GenerateInput, Progress, SEGMENT_CHARS } from "./generate";
import { splitMaterial } from "./study";

const input: GenerateInput = { baseUrl: "https://api.deepseek.com", apiKey: "sk-test", model: "deepseek-flash", kind: "cloze", density: "少" };
const noSleep = async () => {};

function material(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) => `第${index + 1}段：${"节点负责处理请求，并在超时后按退避策略重试。".repeat(60)}`).join("\n");
}

describe("generation failure classification", () => {
  it("treats output truncation as a split signal, not a fatal error", () => {
    expect(classifyFailure("本段材料太长，模型输出被截断。", 502, "too_long")).toBe("too_long");
    expect(classifyFailure("模型输出达到长度限制。请拆小材料后再生成。", 502)).toBe("too_long");
  });

  it("retries transient upstream problems and stops on bad credentials", () => {
    expect(classifyFailure("无法连接 API 地址，请检查网络和 Base URL。", 502)).toBe("retryable");
    expect(classifyFailure("模型接口返回 429：Rate limit", 429)).toBe("retryable");
    expect(classifyFailure("模型接口返回 401：invalid api key", 401)).toBe("fatal");
  });
});

describe("segmented AI card generation", () => {
  it("splits a segment again when the model output is truncated", async () => {
    const calls: string[] = [];
    const post = async (text: string) => {
      calls.push(text);
      if (text.length > 1500) throw new GenerateError("本段材料太长，模型输出被截断。", 502, "too_long");
      return { cards: [{ front: `Q${text.length}`, back: "A" }] };
    };

    const result = await generateCards({ material: material(4), input, post, concurrency: 1, sleep: noSleep });

    expect(result.failures).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(2);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("keeps going when one segment fails for good", async () => {
    const post = async (text: string) => {
      if (text.includes("第2段")) throw new GenerateError("模型接口返回 401：invalid api key", 401);
      return { cards: [{ front: text.slice(0, 8), back: "A" }] };
    };

    const result = await generateCards({ material: material(6), input, post, concurrency: 1, sleep: noSleep });

    expect(result.failures).toHaveLength(1);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("retries a transient error before giving up", async () => {
    let calls = 0;
    const post = async () => {
      calls += 1;
      if (calls === 1) throw new GenerateError("无法连接 API 地址，请检查网络和 Base URL。", 502);
      return { cards: [{ front: "Q", back: "A" }] };
    };

    const result = await generateCards({ material: material(2), input, post, concurrency: 1, sleep: noSleep });

    expect(result.failures).toHaveLength(0);
    expect(calls).toBeGreaterThan(1);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("returns cards in material order even when requests finish out of order", async () => {
    const segments = splitMaterial(material(6), SEGMENT_CHARS);
    expect(segments.length).toBeGreaterThan(1);
    const post = async (text: string) => {
      await new Promise((resolve) => setTimeout(resolve, text.startsWith("第1段") ? 25 : 5));
      return { cards: [{ front: text.slice(0, 6), back: "A" }] };
    };

    const result = await generateCards({ material: material(6), input, post, concurrency: 2, sleep: noSleep });

    expect(result.cards.map((card) => card.front)).toEqual(segments.map((segment) => segment.slice(0, 6)));
  });

  it("adds up real token usage across segments", async () => {
    const progress: Progress[] = [];
    const usage = { prompt: 1900, completion: 800, reasoning: 600, total: 2700, cached: false };
    const post = async () => ({ cards: [{ front: "Q", back: "A" }], usage });

    const result = await generateCards({ material: material(6), input, post, concurrency: 1, sleep: noSleep, onProgress: (value) => progress.push(value) });

    expect(result.tokens).toBe(usage.total * progress.at(-1)!.done);
    expect(result.reasoning).toBe(usage.reasoning * progress.at(-1)!.done);
    expect(progress.at(-1)?.tokens).toBe(result.tokens);
  });

  it("marks segments served from cache as free", async () => {
    const usage = { prompt: 0, completion: 0, reasoning: 0, total: 0, cached: true };
    const post = async () => ({ cards: [{ front: "Q", back: "A" }], usage });

    const result = await generateCards({ material: material(2), input, post, concurrency: 1, sleep: noSleep });

    expect(result.cachedSegments).toBeGreaterThan(0);
    expect(result.tokens).toBe(0);
  });

  it("stops early when the user aborts", async () => {
    const controller = new AbortController();
    const post = async () => {
      controller.abort();
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    };

    const result = await generateCards({ material: material(4), input, post, concurrency: 1, signal: controller.signal, sleep: noSleep });

    expect(result.cancelled).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
