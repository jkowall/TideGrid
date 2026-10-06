import { VisuallyHidden } from "@tidegrid/design-system/components";
import { spokenReference } from "./model.ts";

/**
 * A provider reference as the API masks it. The eye sees "fpay_••••hGvm"; a
 * screen reader hears "fpay, ending in hGvm" rather than four bullets.
 */
export function MaskedReference({ value }: { value: string }) {
  return (
    <>
      <span className="bd-code" aria-hidden="true">
        {value}
      </span>
      <VisuallyHidden>{spokenReference(value)}</VisuallyHidden>
    </>
  );
}
