/** SVG files load as text in the stub gateway's bundle (worker/stub-gateway.wrangler.jsonc). */
declare module "*.svg" {
  const text: string;
  export default text;
}

/** Vite's raw imports, which the Worker's unit tests use for fixture logos. */
declare module "*?raw" {
  const text: string;
  export default text;
}
