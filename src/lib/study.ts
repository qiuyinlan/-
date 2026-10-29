export type Card = {
  id: string;
  kind: "cloze" | "qa";
  front: string;
  back: string;
  section?: string;
  source?: string;
  roundSeen: number;
  stage: number;
  dueAt: number;
  lastReviewed?: number;
  /** 最后一次改动的时间（复习进度变化时刷新；云端合并按它比新旧） */
  updatedAt?: number;
};

export type Deck = {
  id: string;
  name: string;
  createdAt: number;
  cards: Card[];
  rounds: number;
  /** 最后一次改动的时间（改名、加卡、复习都会刷新；云端合并按它比新旧） */
  updatedAt?: number;
};

export const EBBINGHAUS_DAYS = [0, 1, 2, 4, 7, 15, 30, 60];

// 一张卡最多带几句上下文。单句卡信息量太少，回忆时缺少线索。
export const MAX_SENTENCES_PER_CARD = 3;
// 句数之外再兜一层字数上限，防止三句长句拼成一大段。
export const MAX_CARD_CHARS = 240;

export function makeId() {
  return crypto.randomUUID();
}

export function createCard(input: Pick<Card, "kind" | "front" | "back" | "source" | "section">): Card {
  return {
    ...input,
    id: makeId(),
    roundSeen: 0,
    stage: 0,
    dueAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function advanceEbbinghaus(card: Card, remembered: boolean, now = Date.now()): Card {
  const stage = remembered ? Math.min(card.stage + 1, EBBINGHAUS_DAYS.length - 1) : 0;
  const delay = remembered ? EBBINGHAUS_DAYS[stage] : 1;
  return { ...card, stage, lastReviewed: now, dueAt: now + delay * 24 * 60 * 60 * 1000, updatedAt: now };
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

export function splitMaterial(text: string, maxChars = 5000): string[] {
  const chunks: string[] = [];
  let current = "";
  let sectionHeading = "";

  const flush = () => {
    const value = current.trim();
    if (value && value !== sectionHeading.trim()) chunks.push(value);
    current = sectionHeading;
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+.+/u);
    if (heading) {
      flush();
      sectionHeading = `${line.trim()}\n`;
      current = sectionHeading;
      continue;
    }

    let rest = line;
    while (rest.length > maxChars) {
      const limit = Math.max(1, maxChars - current.length);
      let boundary = Math.max(
        rest.lastIndexOf("。", limit), rest.lastIndexOf("！", limit),
        rest.lastIndexOf("？", limit), rest.lastIndexOf(".", limit),
        rest.lastIndexOf(";", limit), rest.lastIndexOf("\t", limit),
      );
      if (boundary < Math.floor(limit * 0.55)) boundary = limit;
      current += `${rest.slice(0, boundary + 1)}\n`;
      rest = rest.slice(boundary + 1);
      flush();
    }

    if (current.length + rest.length + 1 > maxChars) flush();
    current += `${rest}\n`;
  }
  flush();
  return chunks;
}

function candidates(sentence: string): string[] {
  const found: string[] = [];
  const patterns = [
    /[“「『]([^”」』]{2,24})[”」』]/gu,
    /《([^》]{2,24})》/gu,
    /([\u3400-\u9fff]{2,12})(?=是|指|指的是|包括|分为|称为|也叫|简称|由)/gu,
    /(?<!\d)\d+(?:\.\d+)?\s?(?:%|ms|s|分钟|小时|天|年|℃|kg|GB|MB)(?![A-Za-z])|(?<!\d)\d{4}年?(?!\d)/giu,
    /\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3}\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).trim();
      if (value.length > 1 && !found.includes(value)) found.push(value);
    }
  }
  if (!found.length) {
    const cjk = [...sentence.matchAll(/[\u3400-\u9fff]{2,8}/gu)]
      .map((match) => match[0])
      .filter((value) => !["因此", "所以", "但是", "因为", "如果", "这个", "一个", "可以", "进行", "通过"].includes(value));
    found.push(...cjk.slice(0, 4));
    const english = [...sentence.matchAll(/\b[a-zA-Z][a-zA-Z0-9_-]{3,}\b/gu)].map((match) => match[0]);
    found.push(...english.slice(0, 4));
  }
  return [...new Set(found)];
}

export function oneClickCloze(text: string, density: "少" | "多"): Card[] {
  const count = density === "多" ? 2 : 1;
  let section = "未分类";
  const groups: Array<{ text: string; section: string }> = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      section = heading[1].trim().replace(/\*\*/g, "").replace(/`/g, "");
      continue;
    }
    if (!line.trim() || /^\s*[-*|>`]/u.test(line) || /^\s*\d+\.\s/u.test(line)) continue;
    // 同一行里相邻的句子凑成一张卡，最多 3 句、240 字，给回忆留足上下文。
    let group = "";
    let groupSentences = 0;
    const flush = () => {
      if (group) groups.push({ text: group, section });
      group = "";
      groupSentences = 0;
    };
    for (const sentence of splitSentences(line)) {
      const tooManySentences = groupSentences >= MAX_SENTENCES_PER_CARD;
      const tooLong = group.length > 0 && group.length + sentence.length > MAX_CARD_CHARS;
      if (tooManySentences || tooLong) flush();
      group = group ? `${group}${sentence}` : sentence;
      groupSentences += 1;
    }
    flush();
  }
  return groups.flatMap(({ text: passage, section: topic }) => {
    const terms = candidates(passage).slice(0, count);
    if (!terms.length) return [];
    let front = passage;
    const answers: string[] = [];
    terms.forEach((term, index) => {
      const marker = `{{c${index + 1}::${term}}}`;
      front = front.replace(term, marker);
      answers.push(term);
    });
    return [createCard({ kind: "cloze", front, back: answers.join("、"), section: topic, source: passage })];
  });
}

export function countSentences(text: string): number {
  return (text.match(/[。！？!?；;]/g) || []).length;
}

export function countBlanks(front: string): number {
  return (front.match(/\{\{c\d+::/g) || []).length;
}

function renumberBlanks(front: string): string {
  let index = 0;
  return front.replace(/\{\{c\d+::/g, () => `{{c${(index += 1)}::`);
}

// 把相邻的挖空卡拼成"上下文最多 maxSentences 句"的卡：句子更完整，空位全部保留（重新编号）。
// 问答卡不参与合并，并会截断合并组。
export function mergeIntoContextCards(cards: Card[], maxSentences = MAX_SENTENCES_PER_CARD): Card[] {
  const merged: Card[] = [];
  let group: Card[] = [];
  let groupSentences = 0;

  const flush = () => {
    if (!group.length) return;
    if (group.length === 1) { merged.push(group[0]); group = []; groupSentences = 0; return; }
    const [first] = group;
    let front = "";
    for (const card of group) {
      if (front && !/[。！？!?；;：:）)」』】\n]$/u.test(front)) front += " ";
      front += card.front;
    }
    const back = group
      .map((card) => card.back.trim().replace(/[。.]+$/u, ""))
      .filter(Boolean)
      .join("；");
    merged.push({
      ...first,
      front: renumberBlanks(front),
      back: back || first.back,
      dueAt: Math.min(...group.map((card) => card.dueAt)),
      stage: Math.min(...group.map((card) => card.stage)),
      roundSeen: Math.min(...group.map((card) => card.roundSeen)),
      updatedAt: Math.max(...group.map((card) => card.updatedAt ?? 0)),
      lastReviewed: group.reduce<number | undefined>(
        (earliest, card) => card.lastReviewed === undefined ? earliest : Math.min(earliest ?? Number.POSITIVE_INFINITY, card.lastReviewed),
        undefined,
      ),
    });
    group = [];
    groupSentences = 0;
  };

  for (const card of cards) {
    if (card.kind !== "cloze") { flush(); merged.push(card); continue; }
    const width = Math.max(1, countSentences(card.front.replace(/\{\{c\d+::([^}]*)\}\}/g, "$1")));
    if (group.length && groupSentences + width > maxSentences) flush();
    group.push(card);
    groupSentences += width;
  }
  flush();
  return merged;
}

export function formatDue(dueAt: number, now = Date.now()): string {
  if (dueAt <= now) return "到期";
  const days = Math.ceil((dueAt - now) / 86400000);
  return days === 1 ? "明天" : `${days} 天后`;
}

export function dueCards(deck: Deck, now = Date.now()): Card[] {
  return deck.cards.filter((card) => card.dueAt <= now);
}
