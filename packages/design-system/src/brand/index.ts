/**
 * Brand inputs for TideGrid surfaces. The schema itself is the API contract in
 * @tidegrid/contracts (packages/contracts/src/brand.ts) and is re-exported here
 * so there is one definition. This module adds what only the design system
 * knows: the self-hosted font faces behind each supported font id and the
 * mapping from a brand to CSS custom properties.
 *
 * No React and no CSS imports: the seed and the tenant manifest loader use it
 * in Node, and it must stay safe to bundle anywhere.
 */
export {
  BodyFont,
  BrandConfig,
  BrandLogo,
  bodyFontIds,
  brandContrastProblems,
  brandSchemaVersion,
  contrastMinimums,
  contrastRatio,
  DisplayFont,
  displayFontIds,
  GuestCapability,
  guestSurface,
  HexColor,
  isHttpsUrl,
  LinkTarget,
  logoMediaTypes,
  logoProblem,
  maxLogoBytes,
  PublicBrand,
  PublicExperienceResponse,
  PublicTenantIdentity,
  primaryInk,
  relativeLuminance,
  SameOriginPath,
  svgLogoProblem,
} from "@tidegrid/contracts";
export {
  type BodyFontSpec,
  bodyFonts,
  displayFonts,
  type FontSpec,
  targetCharactersPerLine,
} from "./fonts.ts";
export {
  applyBrandTheme,
  type BrandCssVariables,
  type BrandTheme,
  brandCssVariables,
  type CSSStyleDeclarationLike,
  tidegridTheme,
} from "./theme.ts";
