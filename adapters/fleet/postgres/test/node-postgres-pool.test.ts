import { describe, expect, it } from "vitest";

import {
  NodePostgresPool,
  type NodePostgresDriverClient,
  type NodePostgresDriverPool,
} from "../src/index.js";

describe("NodePostgresPool", () => {
  it("adapts driver values without exposing driver records to application code", async () => {
    const calls: Array<{
      readonly text: string;
      readonly values: readonly unknown[];
    }> = [];
    let released = false;
    let ended = false;
    const query = (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve({
        rowCount: 1,
        rows: [{ revision: "1" }],
      });
    };
    const driverClient: NodePostgresDriverClient = {
      query: query as NodePostgresDriverClient["query"],
      release: () => {
        released = true;
      },
    };
    const driverPool: NodePostgresDriverPool = {
      connect: () => Promise.resolve(driverClient),
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    };
    const pool = new NodePostgresPool(driverPool);
    const client = await pool.connect();

    await expect(client.query("SELECT $1::text", ["safe"])).resolves.toEqual({
      rowCount: 1,
      rows: [{ revision: "1" }],
    });
    await expect(client.query("SELECT 1")).resolves.toEqual({
      rowCount: 1,
      rows: [{ revision: "1" }],
    });
    client.release();
    await pool.end();

    expect(calls).toEqual([
      { text: "SELECT $1::text", values: ["safe"] },
      { text: "SELECT 1", values: [] },
    ]);
    expect(released).toBe(true);
    expect(ended).toBe(true);
  });
});
