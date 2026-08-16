import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

// Lightweight YAML parser for simple key-value/list structures
export function parseSimpleYaml(yamlString) {
  const lines = yamlString.split("\n");
  const devices = [];
  let currentDevice = null;

  for (let rawLine of lines) {
    const commentIdx = rawLine.indexOf("#");
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trimEnd();
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith("- id:") || trimmed.startsWith("- name:") || (indent === 2 && trimmed.startsWith("-"))) {
      if (currentDevice && Object.keys(currentDevice).length > 0) {
        devices.push(currentDevice);
      }
      currentDevice = {};
    }

    if (!currentDevice) continue;

    const kvMatch = trimmed.replace(/^- /, "").match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let val = kvMatch[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === "true") {
        val = true;
      } else if (val === "false") {
        val = false;
      } else if (!isNaN(Number(val)) && val !== "") {
        val = Number(val);
      }
      currentDevice[key] = val;
    }
  }

  if (currentDevice && Object.keys(currentDevice).length > 0) {
    devices.push(currentDevice);
  }

  return { devices };
}

export function loadDeviceConfig() {
  const primaryPath = join(ROOT, "devices.yaml");
  const examplePath = join(ROOT, "devices.example.yaml");
  const configPath = existsSync(primaryPath) ? primaryPath : examplePath;

  if (!existsSync(configPath)) {
    return [
      {
        id: "local",
        name: "Local Machine",
        platform: process.platform,
        host: "localhost",
        isLocal: true,
        enabled: true,
      },
    ];
  }

  const content = readFileSync(configPath, "utf8");
  const parsed = parseSimpleYaml(content);
  return (parsed.devices || []).filter((d) => d.enabled !== false);
}

export function probeDevice(device) {
  if (device.isLocal || device.host === "localhost" || device.host === "127.0.0.1") {
    return true;
  }

  const host = device.host;
  const user = device.user || "root";
  const pass = device.pass || "";
  const sudoPass = device.sudoPass || pass || "1212";

  // Test SSH connection with 4s timeout
  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=4",
    ...(pass ? ["-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"] : []),
    `${user}@${host}`,
    "echo online",
  ];

  if (pass) {
    const r = spawnSync("sshpass", ["-p", pass, "ssh", ...sshArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    return r.status === 0 && r.stdout.includes("online");
  }

  const r = spawnSync("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("online");
}

export function execOnDevice(device, remoteCmd, opts = {}) {
  const { allowFail = false, stdio = "inherit" } = opts;

  if (device.isLocal || device.host === "localhost" || device.host === "127.0.0.1") {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "bash";
    const flag = isWin ? "/c" : "-c";
    const r = spawnSync(shell, [flag, remoteCmd], {
      cwd: ROOT,
      stdio,
      env: process.env,
      encoding: "utf8",
    });
    if (r.status !== 0 && !allowFail) {
      throw new Error(`Local command failed [exit ${r.status}]: ${remoteCmd}`);
    }
    return r;
  }

  const host = device.host;
  const user = device.user || "root";
  const pass = device.pass || "";
  const remotePath = device.path || (device.platform === "win32" ? "C:\\Users\\tkach\\resostage" : "~/resostage");

  let fullRemoteCmd = "";
  if (device.platform === "win32") {
    fullRemoteCmd = `cmd /c "call ${remotePath}\\env.bat >NUL 2>&1 & cd /d ${remotePath} && ${remoteCmd}"`;
  } else {
    fullRemoteCmd = `bash -c "export PATH=/usr/bin:/bin:/usr/local/bin:/snap/bin:$HOME/.nvm/versions/node/v24.18.0/lib/node_modules/corepack/shims:$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/.nvm/versions/node/v24.15.0/bin:$HOME/.local/share/pnpm:$PATH; [ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1; cd ${remotePath} && ${remoteCmd}"`;
  }

  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    ...(pass ? ["-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"] : []),
    `${user}@${host}`,
    fullRemoteCmd,
  ];

  let r;
  if (pass) {
    r = spawnSync("sshpass", ["-p", pass, "ssh", ...sshArgs], {
      stdio,
      encoding: "utf8",
    });
  } else {
    r = spawnSync("ssh", sshArgs, { stdio, encoding: "utf8" });
  }

  if (r.status !== 0 && !allowFail) {
    throw new Error(`Remote command failed on ${device.name} (${device.host}) [exit ${r.status}]: ${remoteCmd}`);
  }
  return r;
}
