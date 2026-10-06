import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

/**
 * In-page navigation between the guest site's own pages, so moving from the
 * trips list to a booking keeps the operator's brand on screen instead of
 * loading the site again. Links stay real links: a modified click, a middle
 * click, or a link elsewhere behaves as the browser decides.
 *
 * A page with something to lose, such as an open checkout, can hold a move
 * away: its leave guard answers true when it takes over, for example to ask
 * first, and calls `proceed` once the guest decides to go.
 */

type Navigate = (href: string) => void;
export type LeaveGuard = (proceed: () => void) => boolean;

interface Navigation {
  navigate: Navigate;
  setLeaveGuard: (guard: LeaveGuard | null) => void;
}

const NavigationContext = createContext<Navigation>({
  navigate: (href) => window.location.assign(href),
  setLeaveGuard: () => {},
});

export function NavigationProvider({
  navigate,
  children,
}: {
  navigate: Navigate;
  children: ReactNode;
}) {
  const guard = useRef<LeaveGuard | null>(null);
  const value = useMemo<Navigation>(
    () => ({
      navigate: (href) => {
        const held = guard.current;
        if (held?.(() => navigate(href))) return;
        navigate(href);
      },
      setLeaveGuard: (next) => {
        guard.current = next;
      },
    }),
    [navigate],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigate(): Navigate {
  return useContext(NavigationContext).navigate;
}

/** Hold moves to another page while `guard` is set; released when the page goes. */
export function useLeaveGuard(guard: LeaveGuard | null): void {
  const { setLeaveGuard } = useContext(NavigationContext);
  useEffect(() => {
    setLeaveGuard(guard);
    return () => setLeaveGuard(null);
  }, [guard, setLeaveGuard]);
}

/** An onClick for an <a> on this site: a plain left click navigates in place. */
export function useLinkClick(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const navigate = useNavigate();
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      const link = event.currentTarget;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (link.target && link.target !== "_self") ||
        link.origin !== window.location.origin
      ) {
        return;
      }
      event.preventDefault();
      navigate(`${link.pathname}${link.search}${link.hash}`);
    },
    [navigate],
  );
}
