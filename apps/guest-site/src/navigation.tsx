import { createContext, type MouseEvent, type ReactNode, useCallback, useContext } from "react";

/**
 * In-page navigation between the guest site's own pages, so moving from the
 * trips list to a booking keeps the operator's brand on screen instead of
 * loading the site again. Links stay real links: a modified click, a middle
 * click, or a link elsewhere behaves as the browser decides.
 */

type Navigate = (href: string) => void;

const NavigationContext = createContext<Navigate>((href) => window.location.assign(href));

export function NavigationProvider({
  navigate,
  children,
}: {
  navigate: Navigate;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={navigate}>{children}</NavigationContext.Provider>;
}

export function useNavigate(): Navigate {
  return useContext(NavigationContext);
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
