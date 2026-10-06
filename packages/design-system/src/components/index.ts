/**
 * TideGrid React components. Import the styles once per app through
 * `@tidegrid/design-system/base.css` (tokens, self-hosted fonts, components).
 *
 * Conventions for every screen built on these:
 * - One primary action per screen. Everything else is secondary or ghost.
 * - Status is a StatusBadge or Notice: icon plus label, never color alone.
 * - Loading, empty, error, and success are designed states: Skeleton with a
 *   live text status, EmptyState, Notice tone "error" with a retry, Notice
 *   tone "success".
 * - Standalone links take the `tap-target` class; buttons are 44 px tall.
 * - Wrap the operator console in `.tg-dark`; guest surfaces stay light and
 *   take the tenant brand on <html> through `applyBrandTheme`.
 * - A final action, such as canceling, is confirmed in a Dialog whose one
 *   action is a `danger` button.
 * - Money reaches a screen only through `formatMoney` in
 *   `@tidegrid/design-system/format`, from integer cents; a Ledger shows
 *   line items and their sums without doing any arithmetic itself.
 */
export {
  Button,
  ButtonLink,
  type ButtonLinkProps,
  type ButtonProps,
  type ButtonVariant,
} from "./Button.tsx";
export { CheckboxField, type CheckboxFieldProps } from "./CheckboxField.tsx";
export { cx } from "./cx.ts";
export { Dialog, type DialogProps } from "./Dialog.tsx";
export { ErrorBoundary, type ErrorBoundaryProps } from "./ErrorBoundary.tsx";
export {
  EmptyState,
  type EmptyStateProps,
  Notice,
  type NoticeProps,
  type NoticeTone,
  Skeleton,
  type SkeletonProps,
  Spinner,
  StatusBadge,
  type StatusBadgeProps,
  type StatusTone,
  VisuallyHidden,
} from "./Feedback.tsx";
export { Icon, type IconName, type IconProps, iconNames } from "./Icon.tsx";
export { Ledger, type LedgerProps, type LedgerRow, type LedgerRowKind } from "./Ledger.tsx";
export { type QuantityChange, QuantityField, type QuantityFieldProps } from "./QuantityField.tsx";
export { SelectField, type SelectFieldProps, type SelectOption } from "./SelectField.tsx";
export { Steps, type StepsProps } from "./Steps.tsx";
export { TextField, type TextFieldProps } from "./TextField.tsx";
