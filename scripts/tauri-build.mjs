#!/usr/bin/env node

/**
 * Conditional Tauri build script.
 *
 * - If TAURI_SIGNING_PRIVATE_KEY is set  → normal signed build (updater artifacts enabled)
 * - If missing                           → build WITHOUT updater artifacts so contributors
 *                                          can compile locally without the signing key.
 *
 * Extra CLI args are forwarded to `cargo tauri build`.
 */

import { execSync } from "node:child_process";

const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
const extraArgs = process.argv.slice(2).join(" ");

if (hasSigningKey) {
  console.log("🔑 Signing key detected — building with updater artifacts");
  execSync(`cargo tauri build ${extraArgs}`, { stdio: "inherit" });
} else {
  console.log(
    "⚠️  No TAURI_SIGNING_PRIVATE_KEY found — building WITHOUT updater signing"
  );
  console.log(
    "   (This is fine for local dev. CI/CD sets the key automatically.)\n"
  );
  // Override createUpdaterArtifacts to false so Tauri won't require the key
  const override = JSON.stringify({
    bundle: { createUpdaterArtifacts: false },
  });
  execSync(`cargo tauri build --config '${override}' ${extraArgs}`, {
    stdio: "inherit",
  });
}
