// Explicit, read-only capability probe. No thread or model turn is started.
import { resolve } from "node:path";
import { AppServerProcess } from "../src/server/master/appServerProcess.ts";

const executable = process.argv[2];
const cwd = process.argv[3];
if (!executable || !cwd) {
  process.stderr.write("Usage: node --import tsx scripts/negi_app_server_probe.ts <codex-exe> <cwd>\n");
  process.exitCode = 2;
} else {
  const processHandle = AppServerProcess.launch({ executable: resolve(executable),
    args: ["app-server", "--stdio"], cwd: resolve(cwd),
    client: { transportTimeoutMs: 20_000 } });
  try {
    await processHandle.client.initialize();
    const models = await processHandle.client.discoverModels();
    process.stdout.write(JSON.stringify({
      protocol: "codex-app-server", modelCount: models.length,
      models: models.map((model) => ({ model: model.model, efforts: model.efforts,
        inputModalities: model.inputModalities })),
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`App Server probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await processHandle.stop();
  }
}
