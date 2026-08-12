import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (!existsSync(path.join(root, ".git"))) {
  const requiredArtifacts = ["build/index.js", "build/cli.js"];
  const missingArtifacts = requiredArtifacts.filter(
    (artifact) => !existsSync(path.join(root, artifact))
  );

  if (missingArtifacts.length > 0) {
    console.error(
      `The package is missing committed build artifacts: ${missingArtifacts.join(", ")}`
    );
    process.exit(1);
  }

  console.log("Using committed build artifacts for package installation.");
  process.exit(0);
}

runPnpm(["exec", "husky"]);
runPnpm(["run", "build"]);

function runPnpm(args) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
