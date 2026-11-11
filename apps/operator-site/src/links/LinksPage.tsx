import {
  type ImportantLink,
  ImportantLinkInput,
  isImportantLinkUrl,
  type Membership,
} from "@tidegrid/contracts";
import {
  Button,
  CheckboxField,
  Dialog,
  EmptyState,
  Icon,
  Notice,
  Skeleton,
  StatusBadge,
  TextField,
} from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { canRetry, ReadFailed } from "../bookings/States.tsx";
import { newIdempotencyKey } from "../calendar/api.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canManageLinks, roleNames } from "../roles.ts";
import {
  addLink,
  archiveLink,
  changeLink,
  type LinkProduct,
  loadLinks,
  type LinksPage as Page,
  type SaveFailure,
} from "./api.ts";
import "./links.css";

/**
 * Important links (W3-G2.14b-rest, part 2): the operator's named https links
 * for guests, such as a fishing-license page or a parking map, for every trip
 * or for chosen trips. Guests see them on their booking page and on the help
 * page. Every role reads the list; owners add, change, reorder (by position),
 * and archive links. Nothing is deleted, and an archived link never changes.
 */

export const linksPath = "/links";
export const maxActiveLinks = 25;
const labelLimit = 60;
const noteLimit = 200;
const productLimit = 20;

type Load =
  | { kind: "loading" }
  | { kind: "ready"; page: Page }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

/** Where a link shows, in words. */
export function shownOn(link: Pick<ImportantLink, "productIds">, products: LinkProduct[]): string {
  if (link.productIds === null) return "Every trip";
  const names = link.productIds.map((id) => products.find((p) => p.id === id)?.name ?? "A trip");
  return names.join(", ");
}

export function LinksPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const manage = canManageLinks(role);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const focusHeadingOnLoad = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<ImportantLink | "new" | null>(null);
  const [archiving, setArchiving] = useState<ImportantLink | null>(null);
  const [said, setSaid] = useState("");
  /**
   * The list is being read again after a save. Changes wait until it is in,
   * so no dialog opens with a link's values from before the save.
   */
  const [refreshing, setRefreshing] = useState(false);
  /** After a save or an archive, the link's row (or the add button) takes focus. */
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    // A read after a save keeps the list on screen until the new one arrives.
    setLoad((current) => {
      if (current.kind === "ready") return current;
      return retry && current.kind === "failed"
        ? { ...current, retrying: true }
        : { kind: "loading" };
    });
    void loadLinks(tenantId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRefreshing(false);
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") return setLoad({ kind: "ready", page: result.value });
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, attempt]);

  useEffect(() => {
    if (load.kind === "loading") return;
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target) {
      // The saved link's row, or the add button; the heading when neither is
      // there (an archived link, or a list that failed to load again).
      const element = target === headingTarget ? null : document.getElementById(target);
      (element ?? heading.current)?.focus();
      return;
    }
    if (!focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    if (focusIsLost()) heading.current?.focus();
  }, [load]);

  /**
   * After a save or an archive, read the list again from the API, so the
   * order (position, then when added) and every link's state are the API's,
   * including changes another owner made meanwhile.
   */
  const put = (link: ImportantLink, message: string) => {
    focusAfter.current = link.status === "active" ? rowId(link.id) : addButtonId;
    setSaid(message);
    retryRequested.current = false;
    setRefreshing(true);
    setAttempt((n) => n + 1);
  };

  const header = (
    <PageHeader
      eyebrow={tenantName}
      title="Important links"
      focusHeading={focusHeading}
      headingRef={heading}
    />
  );

  if (load.kind === "loading") {
    return (
      <>
        {header}
        <div className="links-skeleton" aria-hidden="true">
          <Skeleton variant="text" width="min(30rem, 90%)" />
          <Skeleton variant="text" width="min(22rem, 70%)" />
          <Skeleton variant="text" width="min(26rem, 80%)" />
        </div>
      </>
    );
  }
  if (load.kind === "failed") {
    return (
      <>
        {header}
        <ReadFailed
          reason={load.reason}
          noun="the important links"
          tenantName={tenantName}
          failures={load.failures}
          retrying={load.retrying}
          onRetry={() => {
            retryRequested.current = true;
            setAttempt((n) => n + 1);
          }}
        />
      </>
    );
  }

  const { links, products, catalogLoaded } = load.page;
  /** Another owner changed a link meanwhile: read the list again when the dialog closes. */
  const reload = () => {
    focusAfter.current = headingTarget;
    retryRequested.current = false;
    setRefreshing(true);
    setAttempt((n) => n + 1);
  };
  const active = links.filter((l) => l.status === "active").sort((a, b) => a.position - b.position);
  const archived = links.filter((l) => l.status === "archived");
  const full = active.length >= maxActiveLinks;

  return (
    <>
      {header}
      <p className="links-lede">
        Links guests of {tenantName} see on their booking page and on the help page, such as a
        fishing-license page, a parking map, or a packing list. Each one shows the site it opens
        before a guest taps it. TideGrid doesn't check what the page says.
      </p>
      {manage ? (
        <div className="links-actions">
          <Button
            id={addButtonId}
            variant="primary"
            icon="plus"
            disabled={full || refreshing}
            onClick={() => setEditing("new")}
          >
            Add a link
          </Button>
          {full && (
            <p className="links-hint">
              {tenantName} has {maxActiveLinks} links, the most it can show. Archive one to add
              another.
            </p>
          )}
        </div>
      ) : (
        <p className="links-hint">
          Only owners change these links. Your role, {roleNames[membership.role]}, can see them.
        </p>
      )}
      <p className="tg-visually-hidden" role="status">
        {said}
      </p>
      {!catalogLoaded && (
        <Notice tone="warning" title="The trip names didn't load">
          <p>
            Links show, but the trips each one shows on are named "A trip", and they can't be
            changed until the page loads them. Reload the page to try again.
          </p>
        </Notice>
      )}

      {active.length === 0 ? (
        <EmptyState icon="external" title="No links for guests yet">
          <p>
            {manage
              ? "Add a link and guests see it with their booking."
              : `When an owner of ${tenantName} adds a link, it shows here.`}
          </p>
        </EmptyState>
      ) : (
        <ol className="links-list" aria-label="Links guests see, in order">
          {active.map((link) => (
            <li key={link.id} className="console-card links-item">
              <LinkSummary link={link} products={products} />
              {manage && (
                <div className="links-item__actions">
                  <Button
                    icon="pencil"
                    disabled={refreshing}
                    onClick={() => setEditing(link)}
                    aria-describedby={rowId(link.id)}
                  >
                    Change <span className="tg-visually-hidden">{link.label}</span>
                  </Button>
                  <Button
                    icon="lock"
                    disabled={refreshing}
                    onClick={() => setArchiving(link)}
                    aria-describedby={rowId(link.id)}
                  >
                    Archive <span className="tg-visually-hidden">{link.label}</span>
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {archived.length > 0 && (
        <details className="links-archived">
          <summary>Archived links ({archived.length}), which guests no longer see</summary>
          <ul className="links-list">
            {archived.map((link) => (
              <li key={link.id} className="console-card links-item links-item--archived">
                <LinkSummary link={link} products={products} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <LinkDialog
          tenantId={tenantId}
          link={editing === "new" ? null : editing}
          products={products}
          catalogLoaded={catalogLoaded}
          nextPosition={active.length === 0 ? 0 : Math.min(999, (active.at(-1)?.position ?? 0) + 1)}
          onClose={(stale) => {
            const from = editing === "new" ? addButtonId : rowId(editing.id);
            setEditing(null);
            if (stale) return reload();
            requestAnimationFrame(() => document.getElementById(from)?.focus());
          }}
          onSaved={(link, added) => {
            setEditing(null);
            put(link, added ? `Added ${link.label}.` : `Saved ${link.label}.`);
          }}
        />
      )}
      {archiving && (
        <ArchiveDialog
          tenantId={tenantId}
          link={archiving}
          onClose={(stale) => {
            const from = rowId(archiving.id);
            setArchiving(null);
            if (stale) return reload();
            requestAnimationFrame(() => document.getElementById(from)?.focus());
          }}
          onArchived={(link) => {
            setArchiving(null);
            put(link, `Archived ${link.label}. Guests no longer see it.`);
          }}
        />
      )}
    </>
  );
}

const addButtonId = "links-add";
/** Focus goes to the page heading after a reload. */
const headingTarget = "#heading";
const rowId = (id: string) => `link-${id}`;

function LinkSummary({ link, products }: { link: ImportantLink; products: LinkProduct[] }) {
  return (
    <div className="links-item__main" id={rowId(link.id)} tabIndex={-1}>
      <p className="links-item__title">
        {link.label}
        {link.status === "archived" && (
          <>
            {" "}
            <StatusBadge tone="neutral">Archived</StatusBadge>
          </>
        )}
      </p>
      <p className="links-item__host">
        <Icon name="external" /> Opens {link.host}
      </p>
      <p className="links-item__url">{link.url}</p>
      {link.description && <p className="links-item__note">{link.description}</p>}
      <p className="links-item__meta">
        Shows on: {shownOn(link, products)}
        <span aria-hidden="true"> · </span>
        <span className="tg-visually-hidden">, </span>
        Position {link.position}
      </p>
    </div>
  );
}

const saveProblems: Record<SaveFailure, string> = {
  signed_out: "You're signed out. Sign in again, then save the link.",
  forbidden: "Only owners change links.",
  suspended: "While this operator is suspended, links can't change.",
  no_access: "You no longer have access to this operator. Ask one of its owners.",
  not_found: "This link isn't here any more. Reload the page.",
  rejected:
    "That link couldn't be saved. Check the name, the https address, and the note, then save again.",
  unreadable:
    "TideGrid sent an answer this console can't read. Reload to check the link was saved.",
  unreachable:
    "TideGrid didn't answer, so it isn't known whether this was saved. Check your connection and send it again: the same change is applied only once.",
  unavailable:
    "TideGrid didn't answer properly, so it isn't known whether this was saved. Send it again in a moment: the same change is applied only once.",
  key_reused: "The link changed while it was being sent. Save again.",
  archived: "This link was archived, so it can't change. Add a new one instead.",
  limit: `An operator shows at most ${maxActiveLinks} links and keeps at most 500, archived ones included. Archive one if ${maxActiveLinks} are showing; at 500, no more can be added.`,
  unknown_product: "One of the chosen trips isn't this operator's any more. Reload the page.",
};

/** What the form checks before sending, in the same terms as the API. */
export function formProblems(form: {
  label: string;
  url: string;
  description: string;
  everyTrip: boolean;
  productIds: string[];
  position: string;
}): Partial<Record<"label" | "url" | "description" | "products" | "position", string>> {
  const problems: Partial<
    Record<"label" | "url" | "description" | "products" | "position", string>
  > = {};
  const label = form.label.trim();
  if (!label) problems.label = "Give the link a name.";
  else if (label.length > labelLimit) problems.label = `Use at most ${labelLimit} characters.`;
  else if (!ImportantLinkInput.shape.label.safeParse(label).success) {
    problems.label = "Remove hidden or control characters from the name.";
  }
  const url = form.url.trim();
  if (!url) problems.url = "Enter the address.";
  else if (!url.startsWith("https://")) problems.url = "Use an address that starts with https://.";
  else if (!isImportantLinkUrl(url)) {
    problems.url =
      "Use a public https address with a site name, not an IP address, a local name, or a user name and password.";
  }
  const note = form.description.trim();
  // Lengths as the contract counts them (UTF-16 code units).
  if (note.length > noteLimit) {
    problems.description = `Use at most ${noteLimit} characters.`;
  } else if (note && !ImportantLinkInput.shape.description.safeParse(note).success) {
    problems.description = "Remove hidden or control characters from the note.";
  }
  if (!form.everyTrip && form.productIds.length === 0)
    problems.products = "Choose at least one trip.";
  if (!form.everyTrip && form.productIds.length > productLimit) {
    problems.products = `Choose at most ${productLimit} trips, or every trip.`;
  }
  const position = Number(form.position);
  if (!/^\d{1,3}$/.test(form.position.trim()) || position < 0 || position > 999) {
    problems.position = "Use a whole number from 0 to 999.";
  }
  return problems;
}

function LinkDialog({
  tenantId,
  link,
  products,
  catalogLoaded,
  nextPosition,
  onClose,
  onSaved,
}: {
  tenantId: string;
  link: ImportantLink | null;
  products: LinkProduct[];
  catalogLoaded: boolean;
  nextPosition: number;
  /** `stale`: the API said the link changed meanwhile, so the page reads the list again. */
  onClose: (stale?: boolean) => void;
  onSaved: (link: ImportantLink, added: boolean) => void;
}) {
  const [label, setLabel] = useState(link?.label ?? "");
  const [url, setUrl] = useState(link?.url ?? "");
  const [description, setDescription] = useState(link?.description ?? "");
  const [everyTrip, setEveryTrip] = useState(link ? link.productIds === null : true);
  const [productIds, setProductIds] = useState<string[]>(link?.productIds ?? []);
  const [position, setPosition] = useState(String(link?.position ?? nextPosition));
  const [shown, setShown] = useState<ReturnType<typeof formProblems>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const key = useRef<{ body: string; key: string } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [stale, setStale] = useState(false);
  // A product the link named when the dialog opened that the catalog no
  // longer lists stays a choice, so unticking it can be undone.
  const choices = [
    ...products,
    ...(link?.productIds ?? [])
      .filter((id) => !products.some((p) => p.id === id))
      .map((id) => ({ id, name: "A trip no longer listed" })),
  ];
  /** Without the trip names, the link keeps the trips it has. */
  const tripsLocked = !catalogLoaded;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const problems = formProblems({ label, url, description, everyTrip, productIds, position });
    setShown(problems);
    setProblem(undefined);
    const firstProblem = (["label", "url", "description", "products", "position"] as const).find(
      (k) => problems[k],
    );
    if (firstProblem) {
      // The trips' problem is on the "Every trip" box, which is always there.
      const target = firstProblem === "products" ? "every" : firstProblem;
      document.getElementById(`${formId}-${target}`)?.focus();
      return;
    }
    const input = {
      label: label.trim(),
      url: url.trim(),
      description: description.trim() || null,
      productIds: everyTrip ? null : productIds,
      position: Number(position),
    };
    const body = JSON.stringify(input);
    if (key.current?.body !== body) key.current = { body, key: newIdempotencyKey() };
    setBusy(true);
    const result = link
      ? await changeLink(tenantId, link.id, input, key.current.key)
      : await addLink(tenantId, input, key.current.key);
    setBusy(false);
    if (result.kind === "saved") return onSaved(result.link, link === null);
    if (result.reason === "key_reused") key.current = null;
    if (result.reason === "archived" || result.reason === "not_found") setStale(true);
    setProblem(saveProblems[result.reason]);
  };

  return (
    <Dialog
      title={link ? `Change ${link.label}` : "Add a link"}
      onClose={() => onClose(stale)}
      dismissible={!busy}
      initialFocus={first}
      restoreFocus={false}
      className="links-dialog"
      footer={
        <>
          <Button onClick={() => onClose(stale)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            icon="check"
            busy={busy}
            busyLabel="Saving…"
          >
            {link ? "Save changes" : "Add link"}
          </Button>
        </>
      }
    >
      <form id={formId} className="links-form" onSubmit={(e) => void submit(e)} noValidate>
        {problem && (
          <Notice tone="error" title="The link wasn't saved">
            <p>{problem}</p>
          </Notice>
        )}
        <TextField
          ref={first}
          id={`${formId}-label`}
          label="Name"
          hint={`What guests see, such as "Fishing license". At most ${labelLimit} characters.`}
          value={label}
          maxLength={labelLimit * 2}
          autoComplete="off"
          error={shown.label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          id={`${formId}-url`}
          label="Address"
          hint="A public https address. Guests see the site's name before they open it."
          type="url"
          inputMode="url"
          value={url}
          autoComplete="off"
          spellCheck={false}
          error={shown.url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
        />
        <TextField
          id={`${formId}-description`}
          label="Note (optional)"
          hint={`A short line under the name, such as "Needed for every angler over 16". At most ${noteLimit} characters.`}
          value={description}
          autoComplete="off"
          error={shown.description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset className="links-form__trips">
          <legend className="tg-field__label">Shows on</legend>
          <CheckboxField
            id={`${formId}-every`}
            label="Every trip"
            checked={everyTrip}
            disabled={tripsLocked || busy}
            hint={
              tripsLocked
                ? "The trip names didn't load, so the trips this link shows on stay as they are."
                : undefined
            }
            error={shown.products}
            onChange={(e) => setEveryTrip(e.target.checked)}
          />
          {!everyTrip && !tripsLocked && (
            <div className="links-form__products">
              {choices.length === 0 ? (
                <p className="links-hint">This operator has no trips to choose yet.</p>
              ) : (
                choices.map((p) => (
                  <CheckboxField
                    key={p.id}
                    label={p.name}
                    checked={productIds.includes(p.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setProductIds((ids) =>
                        e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                      )
                    }
                  />
                ))
              )}
            </div>
          )}
        </fieldset>
        <TextField
          id={`${formId}-position`}
          label="Position"
          hint="Lower numbers come first. Links with the same number keep the order they were added in."
          inputMode="numeric"
          value={position}
          error={shown.position}
          disabled={busy}
          onChange={(e) => setPosition(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

function ArchiveDialog({
  tenantId,
  link,
  onClose,
  onArchived,
}: {
  tenantId: string;
  link: ImportantLink;
  /** `stale`: the link was archived or removed meanwhile, so the page reads the list again. */
  onClose: (stale?: boolean) => void;
  onArchived: (link: ImportantLink) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const key = useRef(newIdempotencyKey());
  const cancel = useRef<HTMLButtonElement>(null);
  const explainId = useId();

  const archive = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const result = await archiveLink(tenantId, link.id, key.current);
    setBusy(false);
    if (result.kind === "saved") return onArchived(result.link);
    // Another owner archived it already: that is what was asked, so show the list as it is now.
    if (result.reason === "archived") return onClose(true);
    if (result.reason === "key_reused") key.current = newIdempotencyKey();
    setProblem(saveProblems[result.reason]);
  };

  return (
    <Dialog
      title={`Archive ${link.label}?`}
      tone="danger"
      onClose={() => onClose()}
      dismissible={!busy}
      initialFocus={cancel}
      describedBy={explainId}
      restoreFocus={false}
      footer={
        <>
          <Button ref={cancel} onClick={() => onClose()} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="danger"
            icon="lock"
            busy={busy}
            busyLabel="Archiving…"
            onClick={() => void archive()}
          >
            Archive link
          </Button>
        </>
      }
    >
      <p id={explainId}>
        Guests stop seeing it right away. An archived link can't be changed or brought back, but you
        can add a new one.
      </p>
      {problem && (
        <Notice tone="error" title="The link wasn't archived">
          <p>{problem}</p>
        </Notice>
      )}
    </Dialog>
  );
}
