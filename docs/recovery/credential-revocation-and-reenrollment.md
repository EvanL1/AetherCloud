---
title: Credential revocation and re-enrollment recovery
description: Contain a suspected Gateway credential and recover identity without reusing claims or weakening Tenant boundaries
updated: 2026-07-18
status: planned
---

# Credential revocation and re-enrollment recovery

Use this runbook when a Gateway credential may be lost, copied, revoked, or
bound to replaced hardware. It describes containment and evidence requirements;
it is not an executable revocation workflow.

## Implemented today

- Gateway registration, enrollment-claim issue, claim, and query exist at the
  domain and application layers with memory and PostgreSQL foundations.
- The PostgreSQL path records aggregate, Audit, and Outbox evidence
  transactionally.
- CloudLink credential verification can reject a credential represented as
  suspended or revoked by its trusted credential source.

These foundations do not provide a production credential authority or a public
recovery command.

## Not implemented

AetherCloud has no credential suspend, revoke, rotate, recover, or re-enroll
application capability. Production credential binding, certificate issuance,
revocation distribution, recovery approval, CA/KMS integration, and public
routes remain planned. An enrollment claim must not be used as a substitute for
those missing controls.

## Safe response

1. Stop issuing new enrollment claims for the affected Gateway.
2. Preserve the Tenant, Project, Gateway, credential generation, session, and
   incident evidence. Never copy a raw claim token into a prompt, log, or ticket.
3. Use the currently authoritative external identity, broker, or certificate
   control to isolate the old credential if that production control exists.
4. Treat the old credential generation as permanently fenced. Do not reactivate
   it or silently move the Gateway between Tenants.
5. Re-enroll only through a future governed recovery use case that creates a new
   claim and a new credential generation with independent approval and audit.
6. After recovery, require a new authenticated CloudLink session and reconcile
   the cloud cursor before accepting new uplinks.

## Escalate

Human security approval is required for suspected disclosure, lost enrollment
responses, hardware replacement, ownership conflicts, or any cross-Tenant
ambiguity. Until a production revocation use case exists, an agent must report
that recovery is unavailable instead of presenting enrollment issue as a
complete recovery.

Read [Gateway identity and enrollment](../concepts/gateway-identity-and-enrollment.md),
the [CloudLink reference](../reference/cloudlink-mqtt-v1.md), and the
[cloud capability map](../concepts/iot-cloud-capability-map.md).
