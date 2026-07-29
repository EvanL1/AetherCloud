export interface CommandDefinition {
  readonly kind: "command";
  readonly name: string;
  readonly permission: string;
  readonly risk: "critical" | "high" | "low" | "medium";
  readonly confirmation: "explicit" | "not-required";
  readonly idempotency: "required";
  readonly expiry: "required";
  readonly audit: "required";
  readonly authorization:
    | "enrollment-token"
    | "gateway-credential"
    | "gateway-credential-claim"
    | "gateway-session-challenge"
    | "tenant-permission";
}

export interface QueryDefinition {
  readonly kind: "query";
  readonly name: string;
  readonly permission: string;
}

export const REGISTER_GATEWAY_COMMAND = Object.freeze({
  kind: "command",
  name: "fleet.gateway.register",
  permission: "fleet.gateway.create",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const ISSUE_GATEWAY_ENROLLMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "fleet.gateway.enrollment.issue",
  permission: "fleet.gateway.enrollment.issue",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const CLAIM_GATEWAY_ENROLLMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "fleet.gateway.enrollment.claim",
  permission: "fleet.gateway.enrollment.claim",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "enrollment-token",
} as const satisfies CommandDefinition);

export const GET_GATEWAY_ENROLLMENT_QUERY = Object.freeze({
  kind: "query",
  name: "fleet.gateway.enrollment.get",
  permission: "fleet.gateway.enrollment.read",
} as const satisfies QueryDefinition);

export const LIST_FLEET_GATEWAYS_QUERY = Object.freeze({
  kind: "query",
  name: "fleet.gateway.list",
  permission: "fleet.gateway.read",
} as const satisfies QueryDefinition);

export const GET_FLEET_GATEWAY_QUERY = Object.freeze({
  kind: "query",
  name: "fleet.gateway.get",
  permission: "fleet.gateway.read",
} as const satisfies QueryDefinition);

export const OPEN_CLOUDLINK_SESSION_COMMAND = Object.freeze({
  kind: "command",
  name: "cloudlink.session.open",
  permission: "cloudlink.session.open",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const REQUEST_CLOUDLINK_SESSION_CHALLENGE_COMMAND = Object.freeze({
  kind: "command",
  name: "cloudlink.session.challenge.request",
  permission: "cloudlink.session.challenge.request",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential-claim",
} as const satisfies CommandDefinition);

export const ACCEPT_GATEWAY_SIGNED_CLOUDLINK_SESSION_COMMAND = Object.freeze({
  kind: "command",
  name: "cloudlink.session.gateway-signed.accept",
  permission: "cloudlink.session.gateway-signed.accept",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-session-challenge",
} as const satisfies CommandDefinition);

export const RECORD_CLOUDLINK_HEARTBEAT_COMMAND = Object.freeze({
  kind: "command",
  name: "cloudlink.session.heartbeat",
  permission: "cloudlink.session.heartbeat",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_CLOUDLINK_SESSION_QUERY = Object.freeze({
  kind: "query",
  name: "fleet.cloudlink.session.get",
  permission: "fleet.cloudlink.session.read",
} as const satisfies QueryDefinition);

export const REPORT_GATEWAY_RUNTIME_MANIFEST_COMMAND = Object.freeze({
  kind: "command",
  name: "fleet.runtime-manifest.report",
  permission: "fleet.runtime-manifest.report",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_GATEWAY_RUNTIME_MANIFEST_QUERY = Object.freeze({
  kind: "query",
  name: "fleet.runtime-manifest.get",
  permission: "fleet.runtime-manifest.read",
} as const satisfies QueryDefinition);

export const INGEST_TELEMETRY_BATCH_COMMAND = Object.freeze({
  kind: "command",
  name: "telemetry.batch.ingest",
  permission: "telemetry.batch.ingest",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_TELEMETRY_HISTORY_QUERY = Object.freeze({
  kind: "query",
  name: "telemetry.history.query",
  permission: "telemetry.history.read",
} as const satisfies QueryDefinition);

export const REPORT_INTEGRATION_TOPOLOGY_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.topology.report",
  permission: "integration.topology.report",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const REPORT_INTEGRATION_OBSERVATIONS_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.observations.report",
  permission: "integration.observations.report",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_INTEGRATION_PROJECTION_QUERY = Object.freeze({
  kind: "query",
  name: "integration.projection.get",
  permission: "integration.projection.read",
} as const satisfies QueryDefinition);

export const LIST_INTEGRATION_PROJECTIONS_QUERY = Object.freeze({
  kind: "query",
  name: "integration.projection.list",
  permission: "integration.projection.read",
} as const satisfies QueryDefinition);

export const CREATE_INTEGRATION_POWER_CONTROL_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.device.power.set",
  permission: "integration.device.control",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const INGEST_INTEGRATION_CONTROL_RECEIPT_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.control.receipt.ingest",
  permission: "integration.control.receipt.ingest",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const INGEST_ALARM_FACT_COMMAND = Object.freeze({
  kind: "command",
  name: "alarm.fact.ingest",
  permission: "alarm.fact.ingest",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_ALARM_PROJECTION_QUERY = Object.freeze({
  kind: "query",
  name: "alarm.projection.get",
  permission: "alarm.projection.read",
} as const satisfies QueryDefinition);

export const ACKNOWLEDGE_ALARM_COMMAND = Object.freeze({
  kind: "command",
  name: "alarm.workflow.acknowledge",
  permission: "alarm.workflow.acknowledge",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const PUBLISH_ARTIFACT_REVISION_COMMAND = Object.freeze({
  kind: "command",
  name: "artifact.revision.publish",
  permission: "artifact.revision.publish",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const GET_ARTIFACT_REVISION_QUERY = Object.freeze({
  kind: "query",
  name: "artifact.revision.get",
  permission: "artifact.revision.read",
} as const satisfies QueryDefinition);

export const MARK_EDGE_DEPLOYMENT_UNKNOWN_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.mark-unknown",
  permission: "deployment.rollout.reconcile",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const START_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.start",
  permission: "deployment.rollout.start",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const PAUSE_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.pause",
  permission: "deployment.rollout.pause",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const RESUME_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.resume",
  permission: "deployment.rollout.resume",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const CANCEL_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.cancel-request",
  permission: "deployment.rollout.cancel",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const ROLLBACK_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.rollout.rollback",
  permission: "deployment.rollout.rollback",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const REPORT_EDGE_DEPLOYMENT_COMMAND = Object.freeze({
  kind: "command",
  name: "deployment.observation.report",
  permission: "deployment.observation.report",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_EDGE_DEPLOYMENT_QUERY = Object.freeze({
  kind: "query",
  name: "deployment.rollout.get",
  permission: "deployment.rollout.read",
} as const satisfies QueryDefinition);

export const CREATE_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.create",
  permission: "edge.job.create",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const CONFIRM_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.confirm",
  permission: "edge.job.confirm",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const QUEUE_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.queue",
  permission: "edge.job.dispatch",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const OFFER_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.offer",
  permission: "edge.job.dispatch",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const MARK_GOVERNED_JOB_UNKNOWN_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.mark-unknown",
  permission: "edge.job.reconcile",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const CANCEL_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.cancel-request",
  permission: "edge.job.cancel",
  risk: "medium",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const EXPIRE_GOVERNED_JOB_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.expire",
  permission: "edge.job.reconcile",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const INGEST_GOVERNED_JOB_RECEIPT_COMMAND = Object.freeze({
  kind: "command",
  name: "edge.job.receipt.ingest",
  permission: "edge.job.receipt.ingest",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "gateway-credential",
} as const satisfies CommandDefinition);

export const GET_GOVERNED_JOB_QUERY = Object.freeze({
  kind: "query",
  name: "edge.job.get",
  permission: "edge.job.read",
} as const satisfies QueryDefinition);

export const SEARCH_AUDIT_EVENTS_QUERY = Object.freeze({
  kind: "query",
  name: "audit.event.search",
  permission: "audit.event.read",
} as const satisfies QueryDefinition);

export const ENQUEUE_WEBHOOK_DELIVERY_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.webhook.delivery.enqueue",
  permission: "integration.webhook.enqueue",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const PROCESS_WEBHOOK_DELIVERY_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.webhook.delivery.process",
  permission: "integration.webhook.deliver",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const REDRIVE_WEBHOOK_DELIVERY_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.webhook.delivery.redrive",
  permission: "integration.webhook.redrive",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const CREATE_WEBHOOK_SUBSCRIPTION_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.webhook.subscription.create",
  permission: "integration.webhook.subscription.create",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const DISABLE_WEBHOOK_SUBSCRIPTION_COMMAND = Object.freeze({
  kind: "command",
  name: "integration.webhook.subscription.disable",
  permission: "integration.webhook.subscription.disable",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const GET_WEBHOOK_SUBSCRIPTION_QUERY = Object.freeze({
  kind: "query",
  name: "integration.webhook.subscription.get",
  permission: "integration.webhook.subscription.read",
} as const satisfies QueryDefinition);

export const REQUEST_DATA_EXPORT_COMMAND = Object.freeze({
  kind: "command",
  name: "data.export.request",
  permission: "data.export.create",
  risk: "high",
  confirmation: "explicit",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const REPORT_DATA_EXPORT_OUTCOME_COMMAND = Object.freeze({
  kind: "command",
  name: "data.export.outcome.report",
  permission: "data.export.process",
  risk: "low",
  confirmation: "not-required",
  idempotency: "required",
  expiry: "required",
  audit: "required",
  authorization: "tenant-permission",
} as const satisfies CommandDefinition);

export const GET_DATA_EXPORT_QUERY = Object.freeze({
  kind: "query",
  name: "data.export.get",
  permission: "data.export.read",
} as const satisfies QueryDefinition);
