import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseInfrastructurePlanId } from "@aether-cloud/domain";

import { NodeOpenTofuWorkspaceFactory } from "../src/index.js";

const roots: string[] = [];
const planId = parseInfrastructurePlanId(
  "018f6f89-4368-7c3a-b7f1-a9f2da491105",
);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aether-cloud-workspace-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("NodeOpenTofuWorkspaceFactory", () => {
  it("creates 0700 workspaces and writes source artifacts as 0600 files", async () => {
    const root = await temporaryRoot();
    const workspace = await new NodeOpenTofuWorkspaceFactory({
      baseDirectory: root,
      maxSavedPlanBytes: 1024,
    }).create(planId);

    await workspace.writeModuleConfiguration(new TextEncoder().encode("{}"));
    await workspace.writeTopologyVariables(new TextEncoder().encode("{}"));

    expect((await stat(workspace.directory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(workspace.directory, "main.tf.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(workspace.directory, "aether.auto.tfvars.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect(await readdir(workspace.directory)).toEqual([
      "aether.auto.tfvars.json",
      "main.tf.json",
    ]);

    await expect(workspace.cleanup()).resolves.toEqual({ ok: true });
    await expect(lstat(workspace.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads a regular saved Plan and restricts it to 0600", async () => {
    const root = await temporaryRoot();
    const workspace = await new NodeOpenTofuWorkspaceFactory({
      baseDirectory: root,
      maxSavedPlanBytes: 1024,
    }).create(planId);
    const content = new TextEncoder().encode("opaque plan");
    await writeFile(workspace.savedPlanPath, content, { mode: 0o666 });

    await expect(workspace.readSavedPlan()).resolves.toEqual(content);
    expect((await stat(workspace.savedPlanPath)).mode & 0o777).toBe(0o600);

    await workspace.cleanup();
  });

  it("rejects a saved Plan symbolic link", async () => {
    const root = await temporaryRoot();
    const workspace = await new NodeOpenTofuWorkspaceFactory({
      baseDirectory: root,
      maxSavedPlanBytes: 1024,
    }).create(planId);
    const target = join(root, "outside.plan");
    await writeFile(target, "outside");
    await symlink(target, workspace.savedPlanPath);

    await expect(workspace.readSavedPlan()).rejects.toThrow(
      "saved Plan must be a regular file",
    );
    expect(await readFile(target, "utf8")).toBe("outside");

    await workspace.cleanup();
  });

  it("rejects a saved Plan over the configured size limit", async () => {
    const root = await temporaryRoot();
    const workspace = await new NodeOpenTofuWorkspaceFactory({
      baseDirectory: root,
      maxSavedPlanBytes: 4,
    }).create(planId);
    await writeFile(workspace.savedPlanPath, "oversized", { mode: 0o600 });

    await expect(workspace.readSavedPlan()).rejects.toThrow(
      "saved Plan exceeds the configured size limit",
    );

    await workspace.cleanup();
  });
});
