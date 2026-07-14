import { TraceFlags, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";

const traceParentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function extractW3CTraceContext(
  headers: Readonly<Record<string, string | undefined>>,
  base: Context,
): Context {
  const traceParent = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "traceparent",
  )?.[1];
  if (traceParent === undefined) return base;
  const match = traceParentPattern.exec(traceParent);
  const traceId = match?.[1];
  const spanId = match?.[2];
  const flags = match?.[3];
  if (
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(spanId)
  ) {
    return base;
  }
  return trace.setSpanContext(base, {
    traceId,
    spanId,
    traceFlags:
      (Number.parseInt(flags, 16) & 1) === 1
        ? TraceFlags.SAMPLED
        : TraceFlags.NONE,
    isRemote: true,
  });
}
