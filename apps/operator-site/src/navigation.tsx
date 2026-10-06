import { ButtonLink, type ButtonLinkProps } from "@tidegrid/design-system/components";
import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useContext,
} from "react";

/**
 * Moving between console pages in place, through the History API, so the
 * shell and the signed-in state stay. The shell provides `navigate`; a page
 * follows a link with ConsoleLink. Addresses carry ids, dates, and booking
 * references only, never a person's name or email.
 */
const NavigationContext = createContext<(to: string) => void>((to) => {
  window.location.assign(to);
});

export function NavigationProvider({
  navigate,
  children,
}: {
  navigate: (to: string) => void;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={navigate}>{children}</NavigationContext.Provider>;
}

export function useNavigate(): (to: string) => void {
  return useContext(NavigationContext);
}

/** Whether a click should open a new tab or window the browser's own way. */
export function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

export interface ConsoleLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
}

/**
 * A link to another console page. A plain click moves in place; a modified
 * click, or a middle click, leaves it to the browser.
 */
export function ConsoleLink({ href, onClick, children, ref, ...rest }: ConsoleLinkProps) {
  const navigate = useNavigate();
  return (
    <a
      ref={ref}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || isModifiedClick(event)) return;
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** A console link that looks like a button, such as "Open roster". */
export function ConsoleButtonLink({ href, onClick, ...rest }: ButtonLinkProps) {
  const navigate = useNavigate();
  return (
    <ButtonLink
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || isModifiedClick(event)) return;
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}
