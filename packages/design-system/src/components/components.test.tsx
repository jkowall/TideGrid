import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  Icon,
  iconNames,
  Notice,
  SelectField,
  Skeleton,
  StatusBadge,
  type StatusTone,
  TextField,
} from "./index.ts";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("components expose their state to assistive technology", () => {
  it("keeps a busy button focusable, announces it, and swaps the label", () => {
    const out = html(
      <Button variant="primary" busy busyLabel="Sending…">
        Send link
      </Button>,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toMatch(/\sdisabled=""/);
    expect(out).toContain("Sending…");
    expect(out).toContain('class="tg-spinner"');
    expect(out).toContain('type="button"');
  });

  it("marks an unavailable button with aria-disabled and no busy state", () => {
    const out = html(<Button disabled>Save</Button>);
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain("aria-busy");
    expect(out).toContain("tg-button--secondary");
  });

  it("renders a link as a button without a role change", () => {
    const out = html(
      <ButtonLink variant="primary" href="tel:+13055550142" icon="phone">
        Call
      </ButtonLink>,
    );
    expect(out).toMatch(/^<a class="tg-button tg-button--primary" href="tel:\+13055550142">/);
  });

  it("ties a field's hint and error to its input", () => {
    const out = html(
      <TextField
        id="email"
        label="Work email"
        hint="Use your work address"
        error="Enter an email"
      />,
    );
    expect(out).toContain('<label class="tg-field__label" for="email">Work email</label>');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="email-hint email-error"');
    expect(out).toContain('id="email-error"');
    const valid = html(<TextField id="name" label="Name" />);
    expect(valid).not.toContain("aria-invalid");
    expect(valid).not.toContain("aria-describedby");
  });

  it("gives every status tone a distinct icon and a visible label", () => {
    const tones: StatusTone[] = ["ready", "warning", "blocked", "info", "pending", "neutral"];
    const icons = new Set<string>();
    for (const tone of tones) {
      const out = html(<StatusBadge tone={tone}>Label {tone}</StatusBadge>);
      expect(out).toContain(`tg-status--${tone}`);
      expect(out).toContain(`Label ${tone}`);
      expect(out).toContain('aria-hidden="true"');
      icons.add(out.slice(out.indexOf("<svg"), out.indexOf("</svg>")));
    }
    expect(icons.size).toBe(tones.length);
  });

  it("announces errors assertively and other notices politely", () => {
    expect(html(<Notice tone="error" title="Failed" />)).toContain('role="alert"');
    expect(html(<Notice tone="success" title="Sent" />)).toContain('role="status"');
    expect(html(<Notice tone="info" title="Static" announce="none" />)).not.toContain("role=");
  });

  it("labels an empty state section by its heading", () => {
    const out = html(<EmptyState title="No trips yet" headingLevel={3} />);
    const id = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<h3 id="${id}" class="tg-empty__title">No trips yet</h3>`);
  });

  it("lets a domain state choose its own icon while the label stays the status", () => {
    const out = html(
      <StatusBadge tone="neutral" icon="flag">
        Completed
      </StatusBadge>,
    );
    const flag = html(<Icon name="flag" />);
    expect(out).toContain(flag);
    expect(out).toContain("Completed");
  });

  it("puts a Next icon after its label and keeps danger a button variant", () => {
    const next = html(
      <Button icon="chevron-right" iconPosition="end">
        Next
      </Button>,
    );
    expect(next.indexOf("<span>Next</span>")).toBeLessThan(next.indexOf("<svg"));
    const danger = html(
      <Button variant="danger" busy busyLabel="Canceling…">
        Cancel trip
      </Button>,
    );
    expect(danger).toContain("tg-button--danger");
    expect(danger).toContain('aria-busy="true"');
    expect(danger).toContain("Canceling…");
  });

  it("ties a select's label, hint, and error to the control", () => {
    const out = html(
      <SelectField
        id="party"
        label="Party size"
        hint="Up to 12 guests"
        error="Choose a party size"
        options={[
          { value: "1", label: "1 guest" },
          { value: "2", label: "2 guests" },
        ]}
        defaultValue="2"
      />,
    );
    expect(out).toContain('<label class="tg-field__label" for="party">Party size</label>');
    expect(out).toContain('aria-describedby="party-hint party-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toMatch(/<option value="2" selected="">2 guests<\/option>/);
    expect(out).toContain('class="tg-icon tg-select__chevron"');
  });

  it("names a dialog by its heading and marks a final one", () => {
    const out = html(
      <Dialog
        title="Cancel this trip?"
        tone="danger"
        describedBy="why"
        onClose={() => {}}
        footer={<Button variant="danger">Cancel trip</Button>}
      >
        <p id="why">Canceling is final.</p>
      </Dialog>,
    );
    const id = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<h2 id="${id}" class="tg-dialog__title">Cancel this trip?</h2>`);
    expect(out).toContain('aria-describedby="why"');
    expect(out).toMatch(/^<dialog class="tg-dialog tg-dialog--danger"/);
    // Closed until it mounts in a browser and calls showModal.
    expect(out).not.toMatch(/<dialog[^>]*\sopen/);
  });

  it("hides decorative skeletons and icons from assistive technology", () => {
    expect(html(<Skeleton variant="text" width="40%" />)).toContain('aria-hidden="true"');
    for (const name of iconNames)
      expect(html(<Icon name={name} />)).toContain('aria-hidden="true"');
    expect(html(<Icon name="phone" label="Phone" />)).toContain('role="img" aria-label="Phone"');
  });
});
