import { splitMaterial } from "./study";

export type GeneratedCard = { front: string; back: string; section?: string };

export type GenerateInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  kind: "cloze" | "qa";
  density: "少" | "多";
};

export type Usage = { prompt: number; completion: number; reasoning: number; total: number; cached: boolean };

export type Progress = {
  total: number;
  done: number;
  cards: number;
  failures: number;
  truncated: number;
  tokens: number;
  cachedSegments: number;
};

export type Failure = { segment: number; size: number; error: string };

export type GenerateResult = {
  cards: GeneratedCard[];
  failures: Failure[];
  cancelled: boolean;
  truncated: number;
  tokens: number;
  reasoning: number;
  cachedSegments: number;
};

// 单段材料越大，推理型模型想得越久、越容易被服务商按长请求掐断，也越容易把输出顶到长度上限。
// 3000 字左右实测最稳（deepseek-v4-pro 单段 60–120 秒内返回）。
export const SEGMENT_CHARS = 3000;
export const MIN_SEGMENT_CHARS = 1000;
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = [1500, 4000, 8000];

export class GenerateError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "GenerateError";
    this.status = status;
    this.code = code;
  }
}

type Kind = "too_long" | "retryable" | "fatal";

export function classifyFailure(message: string, status = 0, code?: string): Kind {
  if (code === "too_long" || /长度限制|被截断|足够长的输出|max_tokens|maximum context|too long|too many tokens/iu.test(message)) return "too_long";
  if (status === 401 || status === 403 || status === 404) return "fatal";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "fatal";
  if (/超时|无法连接|网络|限流|频率|稍后|请重试|请再试一次|没有生成有效卡片|没有生成卡片|内容不完整|JSON 格式|接口没有返回|已拒绝/iu.test(message)) return "retryable";
  return "retryable";
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.message === "已中止");

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 分段生成卡片：并发跑多段、单段失败自动重试、输出被截断时自动拆小重试、
 * 单段彻底失败不会中断整轮（剩余的段继续生成）。
 */
export async function generateCards(options: {
  material: string;
  input: GenerateInput;
  post: (text: string, signal: AbortSignal) => Promise<{ cards: GeneratedCard[]; truncated?: boolean; usage?: Usage }>;
  onProgress?: (progress: Progress) => void;
  onSegment?: (order: number, cards: GeneratedCard[], truncated: boolean) => void;
  signal?: AbortSignal;
  concurrency?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<GenerateResult> {
  const { material, post, onProgress, onSegment, signal } = options;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_ATTEMPTS);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const pending: Array<{ order: number; text: string }> = splitMaterial(material, SEGMENT_CHARS).map((text, index) => ({ order: index, text }));
  const outputs: Array<{ order: number; cards: GeneratedCard[] }> = [];
  const failures: Failure[] = [];

  let done = 0;
  let cardCount = 0;
  let truncatedCount = 0;
  let tokens = 0;
  let reasoning = 0;
  let cachedSegments = 0;
  let active = 0;
  let cancelled = false;

  const report = () => onProgress?.({
    total: done + pending.length + active, done, cards: cardCount, failures: failures.length,
    truncated: truncatedCount, tokens, cachedSegments,
  });

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) { cancelled = true; return; }
      const job = pending.shift();
      if (!job) return;
      active += 1;
      report();
      let attempt = 0;
      for (;;) {
        try {
          const result = await post(job.text, signal ?? new AbortController().signal);
          if (!result?.cards?.length) throw new GenerateError("模型没有生成有效卡片，请再试一次。");
          outputs.push({ order: job.order, cards: result.cards });
          cardCount += result.cards.length;
          if (result.usage) {
            tokens += result.usage.total;
            reasoning += result.usage.reasoning;
            if (result.usage.cached) cachedSegments += 1;
          }
          done += 1;
          if (result.truncated) truncatedCount += 1;
          active -= 1;
          onSegment?.(job.order, result.cards, Boolean(result.truncated));
          report();
          break;
        } catch (error) {
          if (signal?.aborted || isAbort(error)) { cancelled = true; active -= 1; return; }
          const message = messageOf(error);
          const status = error instanceof GenerateError ? error.status : 0;
          const code = error instanceof GenerateError ? error.code : undefined;
          const kind = classifyFailure(message, status, code);

          if (kind === "too_long" && job.text.length > MIN_SEGMENT_CHARS) {
            const children = splitMaterial(job.text, Math.max(MIN_SEGMENT_CHARS, Math.ceil(job.text.length / 2)));
            if (children.length > 1) {
              pending.unshift(...children.map((text, index) => ({ order: job.order + (index + 1) / 10, text })));
              active -= 1;
              report();
              break;
            }
          }

          attempt += 1;
          if (kind === "fatal" || attempt >= maxAttempts) {
            failures.push({ segment: job.order, size: job.text.length, error: message });
            active -= 1;
            report();
            break;
          }
          report();
          await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const cards = outputs.sort((a, b) => a.order - b.order).flatMap((output) => output.cards);
  return { cards, failures, cancelled, truncated: truncatedCount, tokens, reasoning, cachedSegments };
}
