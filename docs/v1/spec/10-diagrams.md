# 10. Diagrams

The complete diagram set is in the [diagram catalog](../diagrams/README.md). Mermaid source is authoritative and must parse in CI.

| View | Primary question |
|---|---|
| System context | Who uses TideGrid and which external systems participate? |
| Container | Which deployable clients, runtime services, and stores exist? |
| Backend modules | Which bounded contexts own behavior? |
| Deployment | Where do Cloudflare, Neon on Azure, devices, and providers meet? |
| Booking/payment | How do holds, Stripe, and finalization recover? |
| Package redemption | How is the final unit protected? |
| Rental hold | How is finite equipment protected? |
| Stripe webhook | How are signatures, duplicates, and ordering handled? |
| Twilio callback | How do delivery, reply, and opt-out enter the system? |
| Weather disruption | Where is human approval enforced? |
| Offline bundle | How does a captain obtain complete encrypted data? |
| Offline commands | How are commands deduplicated and conflicts surfaced? |
| Private charter | How does an option become a paid booking? |
| ER overview | Which aggregates and records connect? |
| Trust boundary | Where does sensitive data cross and where is it encrypted? |
