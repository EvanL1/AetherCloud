import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InfrastructurePlanId } from "@aether-cloud/domain";

import type {
  OpenTofuWorkspace,
  OpenTofuWorkspaceFactory,
} from "./open-tofu-contracts.js";

export interface NodeOpenTofuWorkspaceFactoryOptions {
  readonly baseDirectory?: string;
  readonly maxSavedPlanBytes: number;
}

class NodeOpenTofuWorkspace implements OpenTofuWorkspace {
  readonly directory: string;
  readonly savedPlanPath: string;
  readonly #moduleConfigurationPath: string;
  readonly #topologyVariablesPath: string;
  readonly #maxSavedPlanBytes: number;

  constructor(directory: string, maxSavedPlanBytes: number) {
    this.directory = directory;
    this.savedPlanPath = join(directory, "aether.plan");
    this.#moduleConfigurationPath = join(directory, "main.tf.json");
    this.#topologyVariablesPath = join(directory, "aether.auto.tfvars.json");
    this.#maxSavedPlanBytes = maxSavedPlanBytes;
  }

  writeModuleConfiguration(content: Uint8Array): Promise<void> {
    return writeFile(this.#moduleConfigurationPath, content, {
      flag: "wx",
      mode: 0o600,
    });
  }

  writeTopologyVariables(content: Uint8Array): Promise<void> {
    return writeFile(this.#topologyVariablesPath, content, {
      flag: "wx",
      mode: 0o600,
    });
  }

  async readSavedPlan(): Promise<Uint8Array> {
    let handle;
    try {
      handle = await open(
        this.savedPlanPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new Error("saved Plan must be a regular file");
    }
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw new Error("saved Plan must be a regular file");
      }
      if (openedMetadata.size > this.#maxSavedPlanBytes) {
        throw new Error("saved Plan exceeds the configured size limit");
      }
      await handle.chmod(0o600);

      const chunks: Buffer[] = [];
      let position = 0;
      while (position <= this.#maxSavedPlanBytes) {
        const remaining = this.#maxSavedPlanBytes - position + 1;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          position,
        );
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position > this.#maxSavedPlanBytes) {
        throw new Error("saved Plan exceeds the configured size limit");
      }
      return new Uint8Array(Buffer.concat(chunks, position));
    } finally {
      await handle.close();
    }
  }

  async cleanup(): Promise<
    Readonly<{ ok: true } | { ok: false; retryable: boolean }>
  > {
    try {
      await rm(this.directory, { recursive: true, force: true });
      return Object.freeze({ ok: true });
    } catch {
      return Object.freeze({ ok: false, retryable: true });
    }
  }
}

export class NodeOpenTofuWorkspaceFactory implements OpenTofuWorkspaceFactory {
  readonly #baseDirectory: string;
  readonly #maxSavedPlanBytes: number;

  constructor(options: NodeOpenTofuWorkspaceFactoryOptions) {
    this.#baseDirectory = options.baseDirectory ?? tmpdir();
    this.#maxSavedPlanBytes = options.maxSavedPlanBytes;
  }

  async create(planId: InfrastructurePlanId): Promise<OpenTofuWorkspace> {
    void planId;
    await mkdir(this.#baseDirectory, { recursive: true });
    const directory = await mkdtemp(
      join(this.#baseDirectory, "aether-cloud-opentofu-"),
    );
    await chmod(directory, 0o700);
    return new NodeOpenTofuWorkspace(directory, this.#maxSavedPlanBytes);
  }
}
