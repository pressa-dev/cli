#!/usr/bin/env node

/**
 * Postinstall script — copies SKILL.md to ~/.claude/skills/pressa/
 * so Claude Code automatically knows how to use Pressa.
 *
 * Runs silently — never fails the install even if copying fails.
 */

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  if (process.env.CI) process.exit(0);

  const home = homedir();
  const skillDir = join(home, ".claude", "skills", "pressa");
  const source = join(__dirname, "SKILL.md");

  // Only install if SKILL.md exists (it should, but be safe)
  if (!existsSync(source)) {
    process.exit(0);
  }

  const target = join(skillDir, "SKILL.md");
  if (existsSync(target)) {
    // Don't overwrite user's customizations
    process.exit(0);
  }

  // Create ~/.claude/skills/pressa/ if it doesn't exist
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });

  // Copy SKILL.md
  copyFileSync(source, target);
} catch {
  // Silently ignore errors — never break npm install
  // Common reasons: permissions, read-only filesystem, CI environment
}
