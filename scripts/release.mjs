import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadDeviceConfig, probeDevice, execOnDevice, ROOT } from "./lib/deviceRunner.mjs";

function logStage(stageNum, stageName) {
  console.log(`\n======================================================`);
  console.log(`  STAGE ${stageNum}: ${stageName.toUpperCase()}`);
  console.log(`======================================================`);
}

function runLocal(cmd) {
  console.log(`[local] $ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`Local command failed [exit ${r.status}]: ${cmd}`);
  }
}

async function release() {
  console.log("======================================================");
  console.log("  ResoStage Multi-OS Automated Release Pipeline");
  console.log("======================================================");

  // 1. Discover online devices
  const allDevices = loadDeviceConfig();
  console.log("\nProbing configured multi-OS devices...");
  const onlineDevices = [];

  for (const dev of allDevices) {
    process.stdout.write(` - ${dev.name} (${dev.platform} @ ${dev.host})... `);
    const isOnline = probeDevice(dev);
    if (isOnline) {
      console.log("ONLINE ✅");
      onlineDevices.push(dev);
    } else {
      console.log("OFFLINE (skipping) ⚠️");
    }
  }

  if (onlineDevices.length === 0) {
    throw new Error("No online devices found for release build!");
  }

  // 2. Auto-commit uncommitted changes & push
  logStage(0, "Git Working Tree Sync & Push");
  const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  if (gitStatus.stdout && gitStatus.stdout.trim().length > 0) {
    console.log("Uncommitted changes detected. Auto-committing...");
    runLocal("git add -A");
    runLocal('git commit -m "chore(release): auto-commit before multi-OS release [skip ci]"');
    runLocal("git push origin main");
    console.log("Changes pushed to origin/main successfully.");
  } else {
    console.log("Git working tree clean.");
  }

  // Define stages to run on all online devices
  const STAGES = [
    { num: 1, name: "Git Pull", cmd: "git pull" },
    { num: 2, name: "Install Dependencies", cmd: "pnpm install" },
    { num: 3, name: "Run Tests", cmd: "pnpm test && node scripts/test-remote.mjs" },
    { num: 4, name: "Rebuild App", cmd: "pnpm rebuild" },
    { num: 5, name: "Publish Installers", cmd: "pnpm run publish" },
  ];

  for (const stage of STAGES) {
    logStage(stage.num, stage.name);
    for (const dev of onlineDevices) {
      console.log(`\n>>> Executing Stage ${stage.num} (${stage.name}) on [${dev.name}]...`);
      execOnDevice(dev, stage.cmd, { stdio: "inherit" });
      console.log(`<<< Stage ${stage.num} on [${dev.name}] PASSED ✅`);

      // Clean up running app/test processes after test stage
      if (stage.num === 3) {
        console.log(`Cleaning up test processes on [${dev.name}]...`);
        execOnDevice(dev, "node scripts/dev.mjs kill", { allowFail: true });
      }
    }
  }

  // 6. Collect Artifacts into build/release/<platform>/<arch>/
  logStage(6, "Artifact Collection");
  const releaseDist = join(ROOT, "build", "release");
  rmSync(releaseDist, { recursive: true, force: true });
  mkdirSync(releaseDist, { recursive: true });

  for (const dev of onlineDevices) {
    const plat = dev.platform;
    const arch = dev.arch || (plat === "win32" ? "x64" : plat === "linux" ? "x64" : process.arch);
    const platDir = plat === "darwin" ? "mac" : plat === "win32" ? "win" : plat;
    const targetFolder = join(releaseDist, platDir, arch);
    rmSync(targetFolder, { recursive: true, force: true });
    mkdirSync(targetFolder, { recursive: true });

    console.log(`Collecting artifacts from [${dev.name}] into build/release/${platDir}/${arch}...`);

    if (dev.isLocal || dev.host === "localhost" || dev.host === "127.0.0.1") {
      const pubVersionDir = join(ROOT, "build", platDir, arch, "publish", "0.1.0");
      const localBuildDir = existsSync(pubVersionDir) ? pubVersionDir : join(ROOT, "build", platDir, arch, "publish");
      if (existsSync(localBuildDir)) {
        cpSync(localBuildDir, targetFolder, { recursive: true });
        console.log(`  -> Copied local artifacts from ${localBuildDir}`);
      }
    } else {
      // Remote device artifact copy via scp
      const host = dev.host;
      const user = dev.user || "root";
      const pass = dev.pass || "";
      const remotePath = dev.path || (plat === "win32" ? "C:\\Users\\tkach\\resostage" : "~/resostage");

      const remoteBuildPath = plat === "win32"
        ? `${remotePath}/build/win/x64/publish/0.1.0/*`
        : `${remotePath}/build/linux/x64/publish/0.1.0/*`;

      const scpArgs = [
        "-r",
        "-o", "StrictHostKeyChecking=no",
        `${user}@${host}:${remoteBuildPath}`,
        targetFolder,
      ];

      if (pass) {
        spawnSync("sshpass", ["-p", pass, "scp", ...scpArgs], { stdio: "inherit" });
      } else {
        spawnSync("scp", scpArgs, { stdio: "inherit" });
      }
      console.log(`  -> Downloaded remote artifacts from ${dev.name}`);
    }
  }

  console.log("\n======================================================");
  console.log("🎉 MULTI-OS RELEASE & TESTING COMPLETED SUCCESSFULLY!");
  console.log(`Artifacts collected in: ${releaseDist}`);
  console.log("======================================================\n");
}

release().catch((err) => {
  console.error("\n❌ RELEASE PIPELINE FAILED:", err.message);
  process.exit(1);
});
