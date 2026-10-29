import type { ReactNode } from "react";

export function toggleBlank(current: Set<number>, index: number): Set<number> {
  const next = new Set(current);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export function everyBlank(total: number): Set<number> {
  return new Set(Array.from({ length: Math.max(0, total) }, (_, index) => index));
}

/**
 * 把 {{c1::答案}} 渲染成可点的空。
 * shown 里有的空显示答案；给了 onToggle 时空可点（点空只翻这一个，点卡片其余位置翻全部）。
 */
export function ClozeText({ text, shown, onToggle }: { text: string; shown?: Set<number> | null; onToggle?: (index: number) => void }) {
  const pattern = /\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = -1;
  for (const match of text.matchAll(pattern)) {
    index += 1;
    // 必须每轮把下标固定下来：闭包里的 let 会一直变，事件触发时它早就是最后一个了。
    const blankIndex = index;
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const revealed = Boolean(shown?.has(blankIndex));
    parts.push(
      <span
        key={`${start}-${blankIndex}`}
        className={`cloze-blank ${revealed ? "is-revealed" : ""} ${onToggle ? "is-clickable" : ""}`}
        role={onToggle ? "button" : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onClick={onToggle ? (event) => { event.stopPropagation(); onToggle(blankIndex); } : undefined}
        onKeyDown={onToggle ? (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onToggle(blankIndex);
        } : undefined}
      >
        {revealed ? match[1] : "　　"}
      </span>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
