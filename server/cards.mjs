export function buildPrompt({ kind, density, text }) {
  const cloze = kind === "cloze";
  // 每段最多出几张卡：卡片数和 token 消耗几乎成正比，想省钱就把这个调小。
  const cap = Number(process.env.HUIXIANG_CARDS_PER_SEGMENT) || 12;
  const instruction = cloze
    ? `请把材料整理成高质量的知识点挖空卡。挖空密度“${density === "多" ? "多" : "少"}”表示每张卡的空数：${density === "多" ? "同一知识点可以挖 1-2 个相互关联的关键词" : "每张卡只挖 1 个最关键的关键词"}。不要按句子机械地逐句挖空；先判断句子是否承载值得记忆的知识，再决定是否制卡。每张卡只考一个清晰知识点：front 取原文 2-3 句（最多 3 句）做上下文，连续叙述的材料尽量取满 3 句，只有材料本身只有一句、或那句话已经独立说清一个概念时才用 1 句；只在这 2-3 句里挖空，用 {{c1::答案}} 标空；双空时使用 {{c1::答案}} 和 {{c2::答案}}。超过 3 句的段落拆成多张卡，不要一张卡塞整段。back 给出答案，解释只在能澄清知识时用一句话补充。`
    : "从材料中筛选值得记忆和考查的核心知识点，生成准确、简洁的主动回忆问答卡。每张卡只问一个知识点，front 是明确问题，back 用 2-3 句话回答（最多 3 句），宁可多分一张卡，不要把整段答案堆在 back 里。";

  return `${instruction}\n\n筛选规则：\n- 优先考查定义、节点职责、因果关系、关键约束、流程分支、失败策略、重要数字和容易混淆的区别。\n- 忽略寒暄、开场交代、章节标题、承上启下、重复总结、写作说明、来源声明、面试话术和不承载知识的修辞。\n- 表格按“一个重要对比/规则一张卡”整理，不要把整行废话照抄成卡。代码和标识符只有在解释其作用或含义时才挖空。
- 卡面（front）用完整的 1-3 句原文做上下文，最多 3 句；不要只截半句话，也不要把三句以上的整段压进一张卡。\n- 根据卡片对应的最近一个 Markdown 标题或小节标题填写 section，原样保留简洁的章节名；不要把章节标题本身当成卡片。没有标题时填写“未分类”。\n- 只依据材料，不要补充材料外的事实。覆盖当前这一段的主要知识点，但不要为了凑数量而制卡，最多生成 ${cap} 张。\n\n只返回符合 JSON 格式的对象，不要 Markdown 或其他前后缀：{\"cards\":[{\"section\":\"一、链路形态\",\"front\":\"...\",\"back\":\"...\"}]}。\n\n材料：\n${text}`;
}

function scanObjects(content) {
  const objects = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== "{") { index += 1; continue; }
    const start = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < content.length; i += 1) {
      const char = content[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) { index = start + 1; continue; }
    objects.push(content.slice(start, end + 1));
    index = end + 1;
  }
  return objects;
}

function normalizeCards(list) {
  return list
    .filter((card) => typeof card?.front === "string" && typeof card?.back === "string")
    .map((card) => ({ front: card.front.trim(), back: card.back.trim(), section: typeof card.section === "string" ? card.section.trim() : "未分类" }))
    .filter((card) => card.front && card.back);
}

// 模型输出被 max_tokens 截断时，JSON 整体解析会失败，但截断点之前的卡片对象是完整的。
// 这里把仍然完整的卡片抢救出来，避免整段作废。
export function salvageCards(content) {
  const cards = [];
  for (const object of scanObjects(content)) {
    let parsed;
    try { parsed = JSON.parse(object); }
    catch { continue; }
    cards.push(...normalizeCards([parsed]));
    if (Array.isArray(parsed?.cards)) cards.push(...normalizeCards(parsed.cards));
  }
  return cards.slice(0, 24);
}

export function parseCards(content) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let json = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (start < 0) {
      if (char === "{") { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) { json = cleaned.slice(start, i + 1); break; }
  }
  if (!json) throw new Error("模型返回内容不完整。请再试一次；如果材料较长，可以拆成几段生成。");
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.cards)) throw new Error("模型没有按要求返回 cards 列表。");
  return normalizeCards(parsed.cards).slice(0, 24);
}
