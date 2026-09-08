import { createServer, type Server } from "node:http";
import { once } from "node:events";

// Child-only bootstrap: never import API bin/server.js or load operator env files.
process.umask(0o077);
let stop: (() => Promise<void>) | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stop?.();
  process.disconnect?.();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("disconnect", () => void shutdown());

try {
  let server: Server;
  if (process.argv[2] === "api") {
    const { Ignitor } = await import(
      "../../api/tests/framework.js"
    );
    const root = new URL("../../api/build/", import.meta.url);
    let apiServer: Server | undefined;
    await new Ignitor(root, {
      importer: (path: string) =>
        import(path.startsWith(".") ? new URL(path, root).href : path),
    })
      .tap((app) => {
        stop = async () => {
          await app.terminate();
        };
        app.terminating(async () => {
          const { db } = await import(new URL("app/database.js", root).href);
          db.close();
        });
      })
      .httpServer()
      .start((handler) => {
        apiServer = createServer(handler);
        return apiServer;
      });
    if (!apiServer) throw new Error("API server was not created");
    server = apiServer;
  } else if (process.argv[2] === "web") {
    const { startServer } = (await import(
      new URL("../dist/server/entry.mjs", import.meta.url).href
    )) as {
      startServer: () => {
        server: { server: Server; stop: () => Promise<void> };
        done: Promise<void>;
      };
    };
    const instance = startServer();
    stop = () => instance.server.stop();
    server = instance.server.server;
    void instance.done.catch(() => {
      process.exitCode = 1;
      void shutdown();
    });
    if (!server.listening) await once(server, "listening");
  } else throw new Error("Unknown fixture service");
  const address = server.address();
  if (
    !server.listening ||
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  )
    throw new Error("Fixture is not listening on loopback");
  if (stopping) await stop?.();
  else
    process.send?.({
      type: "fixture-ready",
      service: process.argv[2],
      port: address.port,
    });
} catch {
  // Child output must never expose credentials, request bodies, or provider settings.
  process.send?.({ type: "fixture-error", service: process.argv[2] });
  process.exitCode = 1;
  await shutdown();
}
