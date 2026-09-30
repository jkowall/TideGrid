# Synthetic tenant manifests

Non-secret tenant and brand manifests for the demo build. Each `<slug>.json` describes one synthetic operator: its slug, display name, preview hostname (`<slug>.book.tidegrid.us`), and its brand, with the logo in `<slug>/`. No real operator appears here; contact details use reserved `.test` domains and the fictional 555-01xx phone range.

The brand fields are exactly what the brand contract (`packages/contracts/src/brand.ts`) allows: primary and accent colors that pass the contrast rules, a display and a body font from the supported set, plain copy, contact details, https or same-site legal links, a locale, and guest capabilities. The logo is an SVG, PNG, or WebP file of at most 32 KB; SVG logos may use only inert shapes, paint, gradients, clipping, and text. `packages/tenant-config` validates every manifest in its unit tests, and the seed refuses to publish one that fails.

`pnpm db:seed` publishes each manifest's brand as an immutable version and activates it, leaving unchanged brands alone. With `SEED_LOCAL_HOSTNAMES=1`, it also maps `<slug>.book.localhost` to each tenant so the guest site can render both brands locally; never set it for a shared environment.
