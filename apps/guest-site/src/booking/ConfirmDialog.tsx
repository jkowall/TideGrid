import { Button, Dialog } from "@tidegrid/design-system/components";
import { type ReactNode, useId, useRef } from "react";

/**
 * Confirms a final step, such as canceling a checkout, as the design system
 * asks: one danger action and a way back. The way back takes focus first, so
 * a stray Enter keeps the checkout. While the request runs, the dialog stays
 * and Escape does nothing, so the guest sees how it ended.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  keepLabel,
  busy,
  onConfirm,
  onKeep,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  keepLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  return (
    <Dialog
      title={title}
      tone="danger"
      dismissible={!busy}
      onClose={onKeep}
      initialFocus={keep}
      describedBy={bodyId}
      footer={
        <>
          <Button variant="danger" busy={busy} busyLabel={busyLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button ref={keep} disabled={busy} onClick={onKeep}>
            {keepLabel}
          </Button>
        </>
      }
    >
      <div id={bodyId}>{children}</div>
    </Dialog>
  );
}
