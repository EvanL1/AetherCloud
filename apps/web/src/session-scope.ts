export interface SessionScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly role: string;
  readonly permissions: readonly string[];
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function nonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

export function decodeSessionScope(input: unknown): SessionScope | null {
  if (!isRecord(input) || !isRecord(input.app_metadata)) return null;
  const metadata = input.app_metadata;
  const tenantId = nonEmptyString(metadata.aethercloud_tenant_id);
  const projectId = nonEmptyString(metadata.aethercloud_project_id);
  const role = nonEmptyString(metadata.aethercloud_role);
  if (
    tenantId === undefined ||
    projectId === undefined ||
    role === undefined ||
    !Array.isArray(metadata.aethercloud_permissions)
  ) {
    return null;
  }
  const permissions: string[] = [];
  for (const permission of metadata.aethercloud_permissions) {
    const decoded = nonEmptyString(permission);
    if (decoded === undefined || permissions.includes(decoded)) return null;
    permissions.push(decoded);
  }
  return Object.freeze({
    tenantId,
    projectId,
    role,
    permissions: Object.freeze(permissions),
  });
}
