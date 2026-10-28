import { join } from "node:path";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import { runtimeHost } from "./runtime-host.js";

export async function continuationHost(
  options?: Parameters<typeof runtimeHost>[0],
): Promise<Awaited<ReturnType<typeof runtimeHost>>> {
  const host = await runtimeHost(options);
  try {
    await host.ctx.plugin(JsonlPersistence, {
      root: join(host.directory, "sessions"),
      compression: "none",
    });
    await host.ctx.plugin(SessionQuery, {
      path: join(host.directory, "query.sqlite"),
      openAt: "never",
    });
    return host;
  } catch (error) {
    await host.close();
    throw error;
  }
}
