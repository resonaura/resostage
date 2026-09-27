#!/usr/bin/env node

/**
 * Creates a repo-local, self-signed macOS code-signing identity.
 *
 * This is deliberately independent of Apple accounts and the login keychain.
 * Its only purpose is to give local ResoStage rebuilds one stable designated
 * requirement so macOS can remember privacy consent across versions.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SIGNING_DIR = join(ROOT, ".resostage-local-signing");
const KEYCHAIN = join(SIGNING_DIR, "resostage.keychain-db");
const PASSWORD_FILE = join(SIGNING_DIR, "keychain-password");
const IDENTITY_NAME = "ResoStage Local Development";

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "ignore", ...options });
}

function identityHash(password) {
  run("security", ["unlock-keychain", "-p", password, KEYCHAIN]);
  const output = execFileSync(
    "security",
    // Self-signed identities are intentionally untrusted by the system and
    // therefore omitted by `-v`; codesign can still use them for local DRs.
    ["find-identity", "-p", "codesigning", KEYCHAIN],
    { encoding: "utf8" },
  );
  const match = output.match(
    /^\s*\d+\)\s+([0-9A-F]+)\s+"ResoStage Local Development"/m,
  );
  return match?.[1] ?? null;
}

mkdirSync(SIGNING_DIR, { recursive: true, mode: 0o700 });
chmodSync(SIGNING_DIR, 0o700);

if (existsSync(KEYCHAIN) && existsSync(PASSWORD_FILE)) {
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  const hash = identityHash(password);
  if (hash) {
    console.log(`✓ Local ResoStage signing identity is ready (${hash})`);
    process.exit(0);
  }
  throw new Error(
    `The local keychain exists but does not contain ${IDENTITY_NAME}. ` +
      `Move ${SIGNING_DIR} aside and run this command again.`,
  );
}

// The password protects only this private build keychain. It never leaves the
// ignored local directory and is not the user's login or system password.
const password = randomBytes(32).toString("hex");
writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
chmodSync(PASSWORD_FILE, 0o600);

const config = join(SIGNING_DIR, "openssl.cnf");
const key = join(SIGNING_DIR, "identity.key");
const certificate = join(SIGNING_DIR, "identity.crt");
const archive = join(SIGNING_DIR, "identity.p12");

writeFileSync(
  config,
  `[req]
prompt = no
distinguished_name = subject
x509_extensions = codesign

[subject]
CN = ${IDENTITY_NAME}
O = ResoStage

[codesign]
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyCertSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
`,
);

try {
  run("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:3072",
    "-x509",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-config",
    config,
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  run("openssl", [
    "pkcs12",
    "-export",
    "-legacy",
    "-inkey",
    key,
    "-in",
    certificate,
    "-name",
    IDENTITY_NAME,
    "-passout",
    `pass:${password}`,
    "-out",
    archive,
  ]);

  run("security", ["create-keychain", "-p", password, KEYCHAIN]);
  run("security", ["unlock-keychain", "-p", password, KEYCHAIN]);
  run("security", ["set-keychain-settings", "-lut", "21600", KEYCHAIN]);
  run("security", [
    "import",
    archive,
    "-k",
    KEYCHAIN,
    "-P",
    password,
    "-T",
    "/usr/bin/codesign",
  ]);
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    password,
    KEYCHAIN,
  ]);

  const hash = identityHash(password);
  if (!hash) throw new Error("The generated code-signing identity is unusable");

  const probe = join(SIGNING_DIR, "codesign-probe");
  execFileSync("cp", [process.execPath, probe]);
  chmodSync(probe, 0o755);
  run("codesign", [
    "--force",
    "--timestamp=none",
    "--keychain",
    KEYCHAIN,
    "--sign",
    hash,
    probe,
  ]);
  run("codesign", ["--verify", "--strict", probe]);
  rmSync(probe, { force: true });

  console.log(`✓ Created free local ResoStage signing identity (${hash})`);
  console.log(`  Keychain: ${KEYCHAIN}`);
  console.log("  Future pnpm dev/app builds will use it automatically.");
} finally {
  // The imported private key remains encrypted inside the private keychain.
  for (const temporary of [config, key, certificate, archive]) {
    rmSync(temporary, { force: true });
  }
}
