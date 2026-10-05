import type { PublicBrand } from "@tidegrid/contracts";
import { ButtonLink } from "@tidegrid/design-system/components";
import { formatPhone } from "./bootstrap.ts";

/**
 * Reach the operator: call when there is a phone number, otherwise email.
 * `primary` makes the first one the screen's primary action; a screen that
 * already has one, such as "Try again", passes false.
 */
export function ContactActions({
  brand,
  primary = true,
}: {
  brand: PublicBrand;
  primary?: boolean;
}) {
  const { phone, email } = brand.contact;
  const first = phone ? (
    <ButtonLink variant={primary ? "primary" : "secondary"} icon="phone" href={`tel:${phone}`}>
      Call {formatPhone(phone)}
    </ButtonLink>
  ) : (
    <ButtonLink variant={primary ? "primary" : "secondary"} icon="mail" href={`mailto:${email}`}>
      Email {brand.name}
    </ButtonLink>
  );
  return (
    <>
      {first}
      {phone && email && (
        <ButtonLink variant="ghost" icon="mail" href={`mailto:${email}`}>
          Email instead
        </ButtonLink>
      )}
    </>
  );
}
