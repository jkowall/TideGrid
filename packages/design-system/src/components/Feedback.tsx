import { createElement, type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./Icon.tsx";

/** Functional status. Each tone pairs a distinct icon shape with its label. */
export type StatusTone = "ready" | "warning" | "blocked" | "info" | "pending" | "neutral";

const statusIcons: Record<StatusTone, IconName> = {
  ready: "check-circle",
  warning: "alert-triangle",
  blocked: "x-octagon",
  info: "info",
  pending: "clock",
  neutral: "dot",
};

export interface StatusBadgeProps {
  tone: StatusTone;
  /** The label is the status. Color and icon only reinforce it. */
  children: ReactNode;
  className?: string;
}

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span className={cx("tg-status", `tg-status--${tone}`, className)}>
      <Icon name={statusIcons[tone]} />
      <span>{children}</span>
    </span>
  );
}

export type NoticeTone = "info" | "success" | "warning" | "error";

const noticeIcons: Record<NoticeTone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert-triangle",
  error: "x-octagon",
};

export interface NoticeProps {
  tone?: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  /** One follow-up action, such as "Try again". */
  actions?: ReactNode;
  /**
   * How assistive technology hears the notice when it appears. Errors default
   * to "alert" (interrupts); everything else to "status" (polite). Use "none"
   * for notices that are part of the page from the start, and let the page say
   * them another way, such as through `aria-describedby` on a focused heading.
   */
  announce?: "alert" | "status" | "none";
  /** For `aria-describedby` on the element that takes focus with the notice. */
  id?: string;
  className?: string;
}

export function Notice({
  tone = "info",
  title,
  children,
  actions,
  announce,
  id,
  className,
}: NoticeProps) {
  const role = announce ?? (tone === "error" ? "alert" : "status");
  return (
    <div
      id={id}
      className={cx("tg-notice", `tg-notice--${tone}`, className)}
      role={role === "none" ? undefined : role}
    >
      <Icon name={noticeIcons[tone]} />
      <div>
        <p className="tg-notice__title">{title}</p>
        {children && <div className="tg-notice__body">{children}</div>}
        {actions && <div className="tg-notice__actions">{actions}</div>}
      </div>
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  /** At most one primary action, plus any secondary ones. */
  actions?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** A designed empty state: what is missing, why, and what to do next. */
export function EmptyState({
  icon = "calendar",
  title,
  children,
  actions,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const id = useId();
  return (
    <section className={cx("tg-empty", className)} aria-labelledby={id}>
      <div className="tg-empty__icon">
        <Icon name={icon} />
      </div>
      {createElement(`h${headingLevel}`, { id, className: "tg-empty__title" }, title)}
      {children && <div className="tg-empty__body">{children}</div>}
      {actions && <div className="tg-empty__actions">{actions}</div>}
    </section>
  );
}

export interface SkeletonProps {
  variant?: "block" | "text" | "circle";
  width?: string;
  height?: string;
  className?: string;
}

/** Loading placeholder. Decorative: pair it with a live text status. */
export function Skeleton({ variant = "block", width, height, className }: SkeletonProps) {
  return (
    <span
      className={cx(
        "tg-skeleton",
        variant === "text" && "tg-skeleton--text",
        variant === "circle" && "tg-skeleton--circle",
        className,
      )}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("tg-spinner", className)} aria-hidden="true" />;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="tg-visually-hidden">{children}</span>;
}
