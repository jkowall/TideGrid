// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, QuantityField } from "@tidegrid/design-system/components";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Design-system behavior that needs a DOM, which the design system's own
// tests (rendered to markup in Node) cannot reach: a busy button's width and
// what typing in a count reports.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a busy Button", () => {
  it("keeps at least its width at rest, so its neighbors never move", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 240,
    } as DOMRect);
    const { rerender } = render(<Button busyLabel="Paying…">Simulate successful payment</Button>);
    const button = screen.getByRole("button");
    expect(button.style.minWidth).toBe("");
    rerender(
      <Button busy busyLabel="Paying…">
        Simulate successful payment
      </Button>,
    );
    expect(button.textContent).toBe("Paying…");
    expect(button.style.minWidth).toBe("240px");
    rerender(<Button busyLabel="Paying…">Simulate successful payment</Button>);
    expect(button.style.minWidth).toBe("");
  });

  it("still hands its element to a caller's ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>Go</Button>);
    expect(ref.current).toBe(screen.getByRole("button"));
  });
});

function Count({
  initial = 2,
  max = 6,
  min = 0,
}: {
  initial?: number;
  max?: number;
  min?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <QuantityField
        label="Adult"
        value={value}
        min={min}
        max={max}
        onChange={setValue}
        decrementLabel="Remove an adult"
        incrementLabel="Add an adult"
      />
      <output>{value}</output>
    </>
  );
}

const input = () => screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement;
const held = () => screen.getByRole("status").textContent;

describe("typing in a QuantityField", () => {
  it("reports a count typed past the most, and never lowers it by itself", () => {
    render(<Count />);
    fireEvent.change(input(), { target: { value: "8" } });
    expect(held()).toBe("8");
    fireEvent.blur(input());
    expect(input().value).toBe("8");
    expect(held()).toBe("8");
  });

  it("steps down by one from a count past the most, and keeps plus unavailable there", () => {
    render(<Count />);
    fireEvent.change(input(), { target: { value: "8" } });
    const plus = screen.getByRole("button", { name: "Add an adult" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Remove an adult" }));
    expect(held()).toBe("7");
  });

  it("counts an emptied field as none once the person leaves it", () => {
    render(<Count />);
    fireEvent.change(input(), { target: { value: "" } });
    expect(held()).toBe("2");
    fireEvent.blur(input());
    expect(held()).toBe("0");
    expect(input().value).toBe("0");
  });

  it("writes a typed count in its plain form when the person leaves it", () => {
    render(<Count />);
    fireEvent.change(input(), { target: { value: "05" } });
    expect(held()).toBe("5");
    fireEvent.blur(input());
    expect(input().value).toBe("5");
  });

  it("says where each count came from, and commits a typed count when the person leaves", () => {
    const log: string[] = [];
    function Recorded() {
      const [value, setValue] = useState(2);
      return (
        <QuantityField
          label="Adult"
          value={value}
          max={6}
          onChange={(next, how) => {
            log.push(`${how} ${next}`);
            setValue(next);
          }}
          onCommit={(count) => log.push(`commit ${count}`)}
          decrementLabel="Remove an adult"
          incrementLabel="Add an adult"
        />
      );
    }
    render(<Recorded />);
    // "12" passes 1 on its way; neither keystroke is final.
    fireEvent.change(input(), { target: { value: "1" } });
    fireEvent.change(input(), { target: { value: "12" } });
    expect(log).toEqual(["typing 1", "typing 12"]);
    fireEvent.blur(input());
    expect(log.at(-1)).toBe("commit 12");
    fireEvent.click(screen.getByRole("button", { name: "Remove an adult" }));
    expect(log.at(-1)).toBe("step 11");
    // Leaving without typing commits nothing.
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(log.at(-1)).toBe("step 11");
    // An emptied field commits none.
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    expect(log.slice(-2)).toEqual(["typing 0", "commit 0"]);
  });
});
