import { describe, expect, it } from "vitest";

import {
  InvalidDomainValueError,
  defineIntegrationControlReceipt,
} from "../src/index.js";

const baseReceipt = {
  jobId: "55555555-5555-4555-8555-555555555555",
  receiptId: "77777777-7777-4777-8777-777777777777",
  receiptSequence: "1",
  capabilityId: "device.power.set.v1",
  target: {
    integrationId: "home-assistant.home",
    snapshotGeneration: "1",
    entityId: "entity-registry-light-bedroom",
    pointKey: "is_on",
  },
  intentDigest:
    "sha256:40108827ca617c95f9d9c48c357fdd94b2b5f019d8ccf8a23842642e934c7327",
  physicalOutcome: "unknown",
  observedAtMs: "1784217600500",
  evidenceDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  audit: {
    auditRecordId: "audit-control-1",
    status: "complete",
  },
} as const;

describe("Integration Control receipt evidence", () => {
  it.each([
    ["unknown", "unknown", "PROVIDER_TIMEOUT"],
    ["edge-rejected", "rejected", "LOCAL_POLICY_DENIED"],
  ] as const)(
    "preserves optional evidence for the %s stage",
    (stage, decision, failureCode) => {
      const receipt = defineIntegrationControlReceipt({
        ...baseReceipt,
        stage,
        decision,
        failureCode,
      });

      expect(receipt.stage).toBe(stage);
      expect(receipt.evidenceDigest).toBe(baseReceipt.evidenceDigest);
    },
  );

  it("rejects evidence for edge acceptance", () => {
    expect(() =>
      defineIntegrationControlReceipt({
        ...baseReceipt,
        stage: "edge-accepted",
        decision: "accepted",
      }),
    ).toThrow(InvalidDomainValueError);
  });
});
