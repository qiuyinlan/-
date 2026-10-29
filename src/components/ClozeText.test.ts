import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClozeText, everyBlank, toggleBlank } from "./ClozeText";

const TEXT = "甲{{c1::ALPHA}}是函数。乙{{c2::BETA}}是对象。";
const render = (props: { text: string; shown?: Set<number> | null; onToggle?: (index: number) => void }) =>
  renderToStaticMarkup(createElement(ClozeText, props));

describe("cloze blank rendering", () => {
  it("hides every answer until its blank is shown", () => {
    const markup = render({ text: TEXT });

    expect(markup).not.toContain("ALPHA");
    expect(markup).not.toContain("BETA");
    expect(markup.match(/cloze-blank/g)).toHaveLength(2);
  });

  it("shows only the blank that was clicked", () => {
    const markup = render({ text: TEXT, shown: new Set([1]), onToggle: () => {} });

    expect(markup).toContain("BETA");
    expect(markup).not.toContain("ALPHA");
    expect(markup.match(/is-revealed/g)).toHaveLength(1);
  });

  it("only makes blanks clickable when a toggle handler is given", () => {
    expect(render({ text: TEXT })).not.toContain("is-clickable");
    expect(render({ text: TEXT, shown: new Set(), onToggle: () => {} }).match(/is-clickable/g)).toHaveLength(2);
  });
});

describe("blank reveal state", () => {
  it("toggles a single blank on and off", () => {
    const once = toggleBlank(new Set(), 1);
    expect([...once]).toEqual([1]);
    expect([...toggleBlank(once, 1)]).toEqual([]);
  });

  it("turns them all on and all off", () => {
    expect([...everyBlank(3)]).toEqual([0, 1, 2]);
    expect([...everyBlank(0)]).toEqual([]);
  });
});

describe("blank click targets", () => {
  // 直接调用组件函数拿到元素树，验证每个空绑的是自己的下标（曾经全都指向最后一个空）。
  const spansOf = (text: string, toggled: number[]) => {
    const tree = ClozeText({ text, shown: new Set(), onToggle: (index) => toggled.push(index) }) as unknown as {
      props: { children: Array<{ type: unknown; props: Record<string, unknown> }> };
    };
    return tree.props.children.filter((child) => child?.type === "span");
  };

  it("hands each blank its own index when clicked", () => {
    const toggled: number[] = [];
    const spans = spansOf(TEXT, toggled);

    expect(spans).toHaveLength(2);
    for (const span of spans) {
      (span.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    }

    expect(toggled).toEqual([0, 1]);
  });

  it("hands each blank its own index on Enter", () => {
    const toggled: number[] = [];
    const spans = spansOf(TEXT, toggled);

    for (const span of spans) {
      (span.props.onKeyDown as (event: Record<string, unknown>) => void)({
        key: "Enter", preventDefault: () => {}, stopPropagation: () => {},
      });
    }

    expect(toggled).toEqual([0, 1]);
  });
});
