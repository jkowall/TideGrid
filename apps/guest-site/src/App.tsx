import { applyBrandTheme } from "@tidegrid/design-system/brand";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { BrandedShell } from "./BrandedShell.tsx";
import { type Experience, loadExperience, settle } from "./bootstrap.ts";
import { FailedState, LoadingState, NotPublishedState, NotReadyState } from "./States.tsx";

type State = { kind: "loading" } | Experience;

function setMeta(name: string, content: string) {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (meta) meta.content = content;
}

/**
 * Show the operator's mark as the tab icon while its brand is applied, and
 * return a function that puts the neutral icon back. A lockup is too wide for
 * a tab, so it keeps the neutral icon. The mark is the same validated SVG data
 * URI the page shows in an <img>.
 */
function setTabIcon(src: string | undefined): () => void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  const previous = link?.getAttribute("href");
  if (!link || !src || previous == null) return () => {};
  link.setAttribute("href", src);
  return () => link.setAttribute("href", previous);
}

/**
 * The guest shell. One build serves every tenant: the API names the operator
 * for this page's origin and returns its validated brand, which is applied to
 * <html> as CSS custom properties before anything branded paints. Until then,
 * and whenever the operator cannot be shown, the page stays neutral.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [retrying, setRetrying] = useState(false);
  // "Try again" disappears when it succeeds, so the page it brings in takes
  // focus. A first load leaves focus at the top of the document.
  const [retried, setRetried] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    // settle() turns anything the loader throws into the failure screen, so
    // the page can never stay on the loading skeleton.
    const next = await settle(() => loadExperience(signal));
    if (!signal?.aborted) setState(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const retry = useCallback(async () => {
    setRetried(true);
    setRetrying(true);
    await load();
    setRetrying(false);
  }, [load]);

  const brand = state.kind === "ready" ? state.brand : null;

  // Before paint, so the first branded frame already has the brand's colors.
  useLayoutEffect(() => {
    if (!brand) return;
    const root = document.documentElement;
    const restore = applyBrandTheme(root, brand);
    const restoreIcon = setTabIcon(brand.logo?.kind === "mark" ? brand.logo.src : undefined);
    const lang = root.lang;
    root.lang = brand.locale;
    setMeta("theme-color", brand.colors.primary);
    return () => {
      restore();
      restoreIcon();
      root.lang = lang;
      setMeta("theme-color", "#f6f7f6");
    };
  }, [brand]);

  switch (state.kind) {
    case "loading":
      return <LoadingState />;
    case "ready":
      return (
        <BrandedShell
          tenant={state.tenant}
          brand={state.brand}
          path={window.location.pathname}
          focusHeading={retried}
        />
      );
    case "not-published":
      return <NotPublishedState host={window.location.hostname} />;
    case "not-ready":
      return <NotReadyState tenant={state.tenant} />;
    case "failed":
      return <FailedState retrying={retrying} onRetry={() => void retry()} />;
  }
}
