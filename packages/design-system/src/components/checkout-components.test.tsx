import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CheckboxField,
  type CheckboxFieldProps,
  Icon,
  iconNames,
  Ledger,
  type LedgerRow,
  QuantityField,
  type QuantityFieldProps,
  Steps,
} from "./index.ts";

const html = (node: ReactElement) => renderToStaticMarkup(node);

type Attributes = Record<string, string>;

/** The attributes of every tag with this name, in order. A bare attribute reads as "". */
function tagsOf(markup: string, name: string): Attributes[] {
  const found: Attributes[] = [];
  for (const tag of markup.matchAll(new RegExp(`<${name}(\\s[^>]*)?>`, "g"))) {
    const attributes: Attributes = {};
    for (const attribute of (tag[1] ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      attributes[attribute[1] as string] = attribute[2] ?? "";
    }
    found.push(attributes);
  }
  return found;
}

/** The attributes of one tag, the first of its name unless an index is given. */
function tag(markup: string, name: string, index = 0): Attributes {
  const found = tagsOf(markup, name)[index];
  if (!found) throw new Error(`no <${name}> at ${index}`);
  return found;
}

/** The markup inside each match of a pattern with one group. */
const insides = (markup: string, pattern: RegExp) =>
  [...markup.matchAll(pattern)].map((match) => match[1] ?? "");

// QuantityField ----------------------------------------------------------------------------------

describe("QuantityField", () => {
  const quantity = (props: Partial<QuantityFieldProps> = {}) =>
    html(
      <QuantityField
        id="adult"
        label="Adult"
        value={2}
        max={10}
        onChange={() => {}}
        decrementLabel="Remove one Adult ticket"
        incrementLabel="Add one Adult ticket"
        {...props}
      />,
    );

  it("ties its label to the input", () => {
    const out = quantity();
    expect(out).toContain('<label class="tg-field__label" for="adult">Adult</label>');
    expect(tag(out, "input").id).toBe("adult");
  });

  it("makes an id when none is given, and ties the label, input, and buttons to it", () => {
    const out = html(
      <QuantityField
        label="Adult"
        value={1}
        max={3}
        onChange={() => {}}
        decrementLabel="Remove"
        incrementLabel="Add"
      />,
    );
    const id = /for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(tag(out, "input").id).toBe(id);
    expect(tagsOf(out, "button").map((button) => button["aria-controls"])).toEqual([id, id]);
  });

  it("gives two fields on a page two ids", () => {
    const field = (label: string) => (
      <QuantityField
        label={label}
        value={0}
        max={3}
        onChange={() => {}}
        decrementLabel={`Remove ${label}`}
        incrementLabel={`Add ${label}`}
      />
    );
    const out = html(
      <>
        {field("Adult")}
        {field("Child")}
      </>,
    );
    const ids = insides(out, /<label[^>]* for="([^"]+)"/g);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("reads its hint and its error with the input", () => {
    const out = quantity({ hint: "$45.00 each", error: "That is more than the boat holds." });
    expect(tag(out, "input")["aria-describedby"]).toBe("adult-hint adult-error");
    expect(out).toContain('<p class="tg-field__hint" id="adult-hint">$45.00 each</p>');
    expect(out).toContain('<p class="tg-field__error" id="adult-error">');
    expect(out).toContain("<span>That is more than the boat holds.</span>");
  });

  it("names only what is there in aria-describedby", () => {
    expect(tag(quantity({ hint: "$45.00 each" }), "input")["aria-describedby"]).toBe("adult-hint");
    expect(tag(quantity({ error: "No" }), "input")["aria-describedby"]).toBe("adult-error");
    expect(tag(quantity(), "input")).not.toHaveProperty("aria-describedby");
  });

  it("marks the input invalid only when there is an error", () => {
    expect(tag(quantity({ error: "No" }), "input")["aria-invalid"]).toBe("true");
    expect(tag(quantity(), "input")).not.toHaveProperty("aria-invalid");
    expect(tag(quantity({ hint: "$45.00 each" }), "input")).not.toHaveProperty("aria-invalid");
  });

  it("names each button for what it does, and ties it to the input", () => {
    const out = quantity();
    expect(tag(out, "button", 0)).toMatchObject({
      type: "button",
      "aria-label": "Remove one Adult ticket",
      "aria-controls": "adult",
    });
    expect(tag(out, "button", 1)).toMatchObject({
      type: "button",
      "aria-label": "Add one Adult ticket",
      "aria-controls": "adult",
    });
    expect(tagsOf(out, "button")).toHaveLength(2);
  });

  it("makes the input a number field with its limits and a step of one", () => {
    expect(tag(quantity({ value: 2, min: 1, max: 10 }), "input")).toMatchObject({
      type: "number",
      inputMode: "numeric",
      min: "1",
      max: "10",
      step: "1",
      value: "2",
    });
    expect(tag(quantity({ max: 3 }), "input")).toMatchObject({ min: "0", max: "3" });
  });

  it("never offers a most below its least", () => {
    const out = quantity({ value: 3, min: 3, max: 1 });
    expect(tag(out, "input").max).toBe("3");
    expect(tag(out, "button", 1)["aria-disabled"]).toBe("true");
  });

  it("says the minus button is unavailable at the minimum, and the plus button is not", () => {
    const atLeast = quantity({ value: 1, min: 1, max: 10 });
    expect(tag(atLeast, "button", 0)["aria-disabled"]).toBe("true");
    expect(tag(atLeast, "button", 1)).not.toHaveProperty("aria-disabled");
    const atZero = quantity({ value: 0, max: 10 });
    expect(tag(atZero, "button", 0)["aria-disabled"]).toBe("true");
    expect(tag(atZero, "button", 1)).not.toHaveProperty("aria-disabled");
  });

  it("says the plus button is unavailable at the maximum, and the minus button is not", () => {
    const atMost = quantity({ value: 10, max: 10 });
    expect(tag(atMost, "button", 1)["aria-disabled"]).toBe("true");
    expect(tag(atMost, "button", 0)).not.toHaveProperty("aria-disabled");
  });

  it("says neither button is unavailable between the limits", () => {
    const between = quantity({ value: 2, min: 1, max: 10 });
    expect(tag(between, "button", 0)).not.toHaveProperty("aria-disabled");
    expect(tag(between, "button", 1)).not.toHaveProperty("aria-disabled");
  });

  it("says both buttons are unavailable when the least and the most are the same", () => {
    const fixed = quantity({ value: 3, min: 3, max: 3 });
    expect(tag(fixed, "button", 0)["aria-disabled"]).toBe("true");
    expect(tag(fixed, "button", 1)["aria-disabled"]).toBe("true");
  });

  it("keeps a button at its limit focusable, as a Button does", () => {
    const atLeast = quantity({ value: 1, min: 1 });
    expect(tag(atLeast, "button", 0)).not.toHaveProperty("disabled");
    expect(quantity({ value: 10, max: 10 })).not.toMatch(/\sdisabled=""/);
  });

  it("makes everything unavailable while the page waits", () => {
    const out = quantity({ value: 2, min: 1, max: 10, disabled: true });
    expect(tag(out, "button", 0)["aria-disabled"]).toBe("true");
    expect(tag(out, "button", 1)["aria-disabled"]).toBe("true");
    expect(tag(out, "input")).toHaveProperty("disabled", "");
  });

  it("has a polite live region, hidden from sight, for what a button changed", () => {
    expect(quantity()).toContain('<span class="tg-visually-hidden" aria-live="polite"></span>');
  });

  it("takes extra classes on its wrapper", () => {
    expect(quantity({ className: "booking-party__count" })).toMatch(
      /^<div class="tg-field tg-quantity booking-party__count">/,
    );
    expect(quantity()).toMatch(/^<div class="tg-field tg-quantity">/);
  });
});

// CheckboxField ---------------------------------------------------------------------------------

describe("CheckboxField", () => {
  const checkbox = (props: Partial<CheckboxFieldProps> = {}) =>
    html(<CheckboxField id="accept" label="I accept this cancellation policy" {...props} />);

  it("puts the checkbox inside its label, so the whole row is the target", () => {
    const out = checkbox();
    expect(out).toMatch(
      /<label class="tg-check__row" for="accept"><input [^>]*\/><span class="tg-check__label">I accept this cancellation policy<\/span><\/label>/,
    );
    expect(tag(out, "input")).toMatchObject({ id: "accept", type: "checkbox" });
  });

  it("makes an id when none is given, and ties the label to it", () => {
    const out = html(<CheckboxField label="I agree" hint="Read it" error="Required" />);
    const id = /for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(tag(out, "input").id).toBe(id);
    expect(tag(out, "input")["aria-describedby"]).toBe(`${id}-hint ${id}-error`);
  });

  it("reads its hint and its error with the checkbox, after the label", () => {
    const out = checkbox({ hint: "Cancel 24 hours ahead for a full refund.", error: "Accept it." });
    expect(tag(out, "input")["aria-describedby"]).toBe("accept-hint accept-error");
    expect(out).toContain(
      '<p class="tg-field__hint" id="accept-hint">Cancel 24 hours ahead for a full refund.</p>',
    );
    expect(out).toContain('<p class="tg-field__error" id="accept-error">');
    expect(out).toContain("<span>Accept it.</span>");
    expect(out.indexOf("</label>")).toBeLessThan(out.indexOf('id="accept-hint"'));
    expect(out.indexOf('id="accept-hint"')).toBeLessThan(out.indexOf('id="accept-error"'));
  });

  it("names only what is there in aria-describedby", () => {
    expect(tag(checkbox({ hint: "Why" }), "input")["aria-describedby"]).toBe("accept-hint");
    expect(tag(checkbox({ error: "No" }), "input")["aria-describedby"]).toBe("accept-error");
    expect(tag(checkbox(), "input")).not.toHaveProperty("aria-describedby");
  });

  it("marks the checkbox invalid only when there is an error", () => {
    expect(tag(checkbox({ error: "Accept it." }), "input")["aria-invalid"]).toBe("true");
    expect(tag(checkbox(), "input")).not.toHaveProperty("aria-invalid");
    expect(tag(checkbox({ hint: "Why" }), "input")).not.toHaveProperty("aria-invalid");
  });

  it("passes the input's own props through", () => {
    const out = checkbox({ name: "policy", required: true, defaultChecked: true, value: "yes" });
    expect(tag(out, "input")).toMatchObject({
      name: "policy",
      required: "",
      checked: "",
      value: "yes",
    });
    expect(tag(checkbox({ disabled: true }), "input")).toHaveProperty("disabled", "");
  });

  it("takes a label with links in it, and extra classes on its wrapper", () => {
    const out = checkbox({
      label: (
        <>
          I accept the <a href="/legal/terms">terms</a>
        </>
      ),
      className: "booking-details__accept",
    });
    expect(out).toContain(
      '<span class="tg-check__label">I accept the <a href="/legal/terms">terms</a></span>',
    );
    expect(out).toMatch(/^<div class="tg-check booking-details__accept">/);
    expect(checkbox()).toMatch(/^<div class="tg-check">/);
  });
});

// Steps -----------------------------------------------------------------------------------------

describe("Steps", () => {
  const names = ["Party", "Details", "Payment"];
  const steps = (current: number, className?: string) =>
    html(
      <Steps
        steps={names}
        current={current}
        label="Booking steps"
        {...(className ? { className } : {})}
      />,
    );
  const items = (out: string) => insides(out, /(<li[^>]*>.*?<\/li>)/g);
  const markers = (out: string) =>
    insides(out, /<span class="tg-steps__marker" aria-hidden="true">(.*?)<\/span>/g);
  const done = '<span class="tg-visually-hidden">, done</span>';

  it("is an ordered list named by its label, one item for each step", () => {
    const out = steps(1);
    expect(out).toMatch(/^<ol class="tg-steps" aria-label="Booking steps">/);
    expect(out).toMatch(/<\/ol>$/);
    expect(items(out)).toHaveLength(3);
    expect(insides(out, /<span class="tg-steps__name">([^<]*)/g)).toEqual(names);
  });

  it("marks only the current step with aria-current", () => {
    for (const current of [0, 1, 2]) {
      const out = steps(current);
      expect(out.match(/aria-current/g)).toHaveLength(1);
      const marked = tagsOf(out, "li").map((li) => li["aria-current"]);
      expect(marked[current]).toBe("step");
      expect(marked.filter((value) => value !== undefined)).toEqual(["step"]);
    }
  });

  it("says in words that a step before the current one is done", () => {
    const out = steps(2);
    const [first, second, third] = items(out);
    expect(first).toContain(`Party${done}`);
    expect(second).toContain(`Details${done}`);
    expect(third).not.toContain(done);
    expect(out.match(/, done/g)).toHaveLength(2);
    expect(steps(1).match(/, done/g)).toHaveLength(1);
    expect(steps(0)).not.toContain(", done");
  });

  it("shows a check for a done step and a number for the current and upcoming ones", () => {
    expect(markers(steps(1))).toEqual([html(<Icon name="check" />), "2", "3"]);
    expect(markers(steps(0))).toEqual(["1", "2", "3"]);
    expect(markers(steps(2))).toEqual([
      html(<Icon name="check" />),
      html(<Icon name="check" />),
      "3",
    ]);
  });

  it("hides the marker from assistive technology, because the name says the rest", () => {
    for (const marker of markers(steps(1))) expect(marker).not.toBe("");
    expect(steps(1).match(/<span class="tg-steps__marker" aria-hidden="true">/g)).toHaveLength(3);
  });

  it("names each step's state in its class", () => {
    const classes = tagsOf(steps(1), "li").map((li) => li.class);
    expect(classes).toEqual([
      "tg-steps__step tg-steps__step--done",
      "tg-steps__step tg-steps__step--current",
      "tg-steps__step tg-steps__step--upcoming",
    ]);
  });

  it("has no done step on the first, and no current step once past the last", () => {
    expect(tagsOf(steps(0), "li").map((li) => li.class)).toEqual([
      "tg-steps__step tg-steps__step--current",
      "tg-steps__step tg-steps__step--upcoming",
      "tg-steps__step tg-steps__step--upcoming",
    ]);
    const past = steps(3);
    expect(past).not.toContain("aria-current");
    expect(past.match(/tg-steps__step--done/g)).toHaveLength(3);
  });

  it("has every step upcoming before the first", () => {
    const before = steps(-1);
    expect(before).not.toContain("aria-current");
    expect(before).not.toContain(", done");
    expect(markers(before)).toEqual(["1", "2", "3"]);
  });

  it("takes extra classes", () => {
    expect(steps(0, "booking__steps")).toMatch(/^<ol class="tg-steps booking__steps"/);
  });
});

// Ledger ----------------------------------------------------------------------------------------

describe("Ledger", () => {
  /** U+2212, which the money formatter uses for a negative amount. */
  const minus = String.fromCharCode(0x2212);
  const rows: LedgerRow[] = [
    { id: "adult", label: "Adult", detail: "2 × $45.00", amount: "$90.00" },
    { id: "photo", label: "Souvenir photo", detail: "1 × $12.00", amount: "$12.00", kind: "item" },
    { id: "subtotal", label: "Subtotal", amount: "$102.00", kind: "subtotal" },
    { id: "off", label: "10% off", amount: `${minus}$9.00`, kind: "adjustment" },
    { id: "total", label: "Total", amount: "$93.00", kind: "total" },
    { id: "tax", label: "Includes County surtax (1%)", amount: "$0.93", kind: "note" },
  ];
  const ledger = (props: { hideCaption?: boolean; className?: string; rows?: LedgerRow[] } = {}) =>
    html(<Ledger caption="Price in US dollars" rows={props.rows ?? rows} {...props} />);
  const rowMarkup = (out: string) => insides(out, /(<tr[^>]*>.*?<\/tr>)/g);

  it("is a table with its caption", () => {
    const out = ledger();
    expect(out).toMatch(/^<table class="tg-ledger">/);
    expect(out).toContain('<caption class="tg-ledger__caption">Price in US dollars</caption>');
    expect(out).not.toContain("tg-visually-hidden");
  });

  it("keeps the caption for screen readers only when asked", () => {
    expect(ledger({ hideCaption: true })).toContain(
      '<caption class="tg-ledger__caption tg-visually-hidden">Price in US dollars</caption>',
    );
  });

  it("makes each label its row's header", () => {
    const out = ledger();
    expect(rowMarkup(out)).toHaveLength(rows.length);
    expect(out.match(/<th /g)).toHaveLength(rows.length);
    expect(out.match(/<th scope="row" class="tg-ledger__item">/g)).toHaveLength(rows.length);
    for (const row of rowMarkup(out)) expect(row.indexOf("<th")).toBeLessThan(row.indexOf("<td"));
    expect(insides(out, /<span class="tg-ledger__label">([^<]*)<\/span>/g)).toEqual(
      rows.map((row) => row.label),
    );
  });

  it("shows the detail under the label only when a row has one", () => {
    const [adult, photo, subtotal] = rowMarkup(ledger());
    expect(adult).toContain(
      '<span class="tg-ledger__label">Adult</span><span class="tg-ledger__detail">2 × $45.00</span>',
    );
    expect(photo).toContain('<span class="tg-ledger__detail">1 × $12.00</span>');
    expect(subtotal).not.toContain("tg-ledger__detail");
    expect(ledger().match(/tg-ledger__detail/g)).toHaveLength(2);
  });

  it("gives each row the class of its kind, and an item by default", () => {
    expect(tagsOf(ledger(), "tr").map((tr) => tr.class)).toEqual([
      "tg-ledger__row tg-ledger__row--item",
      "tg-ledger__row tg-ledger__row--item",
      "tg-ledger__row tg-ledger__row--subtotal",
      "tg-ledger__row tg-ledger__row--adjustment",
      "tg-ledger__row tg-ledger__row--total",
      "tg-ledger__row tg-ledger__row--note",
    ]);
  });

  it("puts each amount in its row's cell exactly as given, in order", () => {
    const out = ledger();
    expect(insides(out, /<td class="tg-ledger__amount">(.*?)<\/td>/g)).toEqual(
      rows.map((row) => row.amount),
    );
    expect(out.match(/<td /g)).toHaveLength(rows.length);
  });

  it("keeps the rows in the order given", () => {
    const reversed = [...rows].reverse();
    expect(insides(ledger({ rows: reversed }), /<span class="tg-ledger__label">([^<]*)</g)).toEqual(
      reversed.map((row) => row.label),
    );
  });

  it("is an empty body for no rows, with its caption", () => {
    const out = ledger({ rows: [] });
    expect(out).toContain("<tbody></tbody>");
    expect(out).toContain("<caption");
  });

  it("takes extra classes", () => {
    expect(ledger({ className: "booking-price" })).toMatch(
      /^<table class="tg-ledger booking-price">/,
    );
  });
});

// Icons -----------------------------------------------------------------------------------------

describe("the icons the checkout added", () => {
  const added = ["check", "plus", "minus", "tag", "credit-card", "receipt"] as const;

  it("lists them in iconNames", () => {
    expect(iconNames).toEqual(expect.arrayContaining([...added]));
  });

  it.each(added)("draws %s as a decorative stroked icon with a shape in it", (name) => {
    const out = html(<Icon name={name} />);
    expect(out).toMatch(/^<svg class="tg-icon" aria-hidden="true" /);
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('stroke="currentColor"');
    expect(out).toMatch(/<(path|rect|circle)\s[^>]*>/);
  });

  it.each(added)("names %s only when a label is given", (name) => {
    expect(html(<Icon name={name} label="Meaning" />)).toContain('role="img" aria-label="Meaning"');
    expect(html(<Icon name={name} />)).not.toContain("aria-label");
  });

  it("draws every icon differently from every other", () => {
    const drawings = iconNames.map((name) => html(<Icon name={name} />));
    expect(new Set(drawings).size).toBe(iconNames.length);
  });
});
