/**
 * Synthetic waiver templates for the demo operators (G2.15): each operator has
 * a participation waiver for every trip, and Demo Reef adds a scuba waiver for
 * its dive, which takes precedence there. Everything goes through the waiver
 * commands, so the seeded versions pass the same checks, and get the same
 * database-computed hashes, a console will.
 *
 * Idempotent: a template that exists is kept, and a template that already has
 * a version gets no other. The texts are synthetic and say so; they are not
 * legal agreements and TideGrid does not draft them.
 */
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  createWaiverTemplate,
  publishWaiverTemplateVersion,
  type WaiverText,
} from "@tidegrid/domain-waivers";

const REASON = "Synthetic demo waiver";

const SYNTHETIC_NOTE =
  "Demo text for a synthetic operator. This is not a real legal agreement, and nothing signed here binds anyone.";

interface TemplatePlan {
  name: string;
  /** A product name as the catalog seed names it; absent for the operator's own template. */
  product?: string;
  text: WaiverText;
}

const plans: Record<string, TemplatePlan[]> = {
  "demo-harbor": [
    {
      name: "Harbor participation waiver",
      text: {
        title: "Demo Harbor Charters participation waiver",
        body: [
          SYNTHETIC_NOTE,
          "Boat trips carry risks, including slips and falls on wet decks, sudden boat movement, sun and heat exposure, sea sickness, and cold water. Weather and sea conditions can change quickly.",
          "I agree to follow the captain's and crew's instructions at all times, to wear a life jacket when asked, and to tell the crew before departure about anything that could affect my safety on board.",
          "I understand that the captain may change, shorten, or cancel a trip for safety, and that the booking's own policy covers any refund.",
          "To the extent the law allows, I release Demo Harbor Charters and its crew from claims for injury or loss caused by the ordinary risks of a boat trip. This does not cover gross negligence or willful misconduct.",
        ].join("\n\n"),
        acknowledgments: [
          "I have read this waiver in full.",
          "I understand the risks of the trip and accept them.",
          "I will follow the crew's safety instructions.",
        ],
      },
    },
  ],
  "demo-reef": [
    {
      name: "Reef participation waiver",
      text: {
        title: "Demo Reef Divers participation waiver",
        body: [
          SYNTHETIC_NOTE,
          "Snorkeling and boat trips carry risks, including drowning, marine life, strong currents, sun exposure, sea sickness, and injury getting on or off the boat.",
          "I confirm that I can swim, that I will stay with my group, and that I will follow the crew's briefing and signals in and out of the water.",
          "To the extent the law allows, I release Demo Reef Divers and its crew from claims for injury or loss caused by the ordinary risks of these activities. This does not cover gross negligence or willful misconduct.",
        ].join("\n\n"),
        acknowledgments: [
          "I have read this waiver in full.",
          "I understand the risks of snorkeling and boat travel and accept them.",
          "I can swim and will follow the crew's briefing.",
        ],
      },
    },
    {
      name: "Scuba diving waiver",
      product: "Two-Tank Morning Dive",
      text: {
        title: "Demo Reef Divers scuba diving waiver",
        body: [
          SYNTHETIC_NOTE,
          "Scuba diving carries risks beyond snorkeling, including decompression sickness, lung overexpansion injuries, nitrogen narcosis, equipment failure, and running low on air. Some of these can be serious or fatal.",
          "I confirm that I hold a current open water certification or higher, that I will dive within my training and the dive plan, that I will check my equipment with my buddy before each dive, and that I will end a dive when the guide signals.",
          "I understand that the guide may change the dive site, depth, or time, or call a dive, for safety.",
          "To the extent the law allows, I release Demo Reef Divers, its guides, and its crew from claims for injury or loss caused by the ordinary risks of scuba diving. This does not cover gross negligence or willful misconduct.",
        ].join("\n\n"),
        acknowledgments: [
          "I have read this waiver in full.",
          "I hold a current scuba certification and will dive within my training.",
          "I understand the risks of scuba diving and accept them.",
          "I will follow the dive plan and my guide's signals.",
        ],
      },
    },
  ],
};

export async function seedWaivers(
  url: string,
  tenants: readonly { id: string; slug: string }[],
): Promise<{ templates: number; versions: number }> {
  const handle = createDb(url, { max: 1 });
  let templates = 0;
  let versions = 0;
  try {
    for (const tenant of tenants) {
      const ctx: TenantContext = {
        tenantId: tenant.id,
        actorType: "system",
        actorId: "seed",
        requestId: "seed-waivers",
      };
      for (const plan of plans[tenant.slug] ?? []) {
        await inTenantTransaction(handle.db, ctx, async (trx) => {
          let scope: { scope: "operator" } | { scope: "product"; productId: string } = {
            scope: "operator",
          };
          if (plan.product) {
            const product = await trx
              .selectFrom("products")
              .select("id")
              .where("tenant_id", "=", tenant.id)
              .where("name", "=", plan.product)
              .executeTakeFirst();
            if (!product) throw new Error(`seed: no product ${plan.product} at ${tenant.slug}`);
            scope = { scope: "product", productId: product.id };
          }
          const created = await createWaiverTemplate(trx, ctx, {
            ...scope,
            name: plan.name,
            reason: REASON,
          });
          if (created.kind !== "created" && created.kind !== "exists") {
            throw new Error(`seed: waiver template ${plan.name}: ${JSON.stringify(created)}`);
          }
          if (created.kind === "created") templates += 1;
          const existing = await trx
            .selectFrom("waiver_template_versions")
            .select("version")
            .where("tenant_id", "=", tenant.id)
            .where("template_id", "=", created.templateId)
            .executeTakeFirst();
          if (existing) return;
          const published = await publishWaiverTemplateVersion(trx, ctx, {
            templateId: created.templateId,
            text: plan.text,
            reason: REASON,
          });
          if (published.kind !== "published") {
            throw new Error(`seed: waiver version ${plan.name}: ${JSON.stringify(published)}`);
          }
          versions += 1;
        });
      }
    }
  } finally {
    await handle.end();
  }
  return { templates, versions };
}
