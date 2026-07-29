/**
 * Fix Registry — tracks successful fixes for Dependabot PRs and suggests
 * previously-approved fixes when the same dependency upgrade breaks other repos.
 *
 * Entries are persisted to a JSON file in the user's home directory so they
 * survive server restarts.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router, Request, Response } from "express";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FixRegistryEntry {
  id: string;
  /** The dependency name that triggered the failure */
  dependencyName: string;
  /** The version that caused the break (e.g., "^7.0.2") */
  brokenVersion: string;
  /** The version it was reverted/fixed to (e.g., "^6.0.3") */
  fixedVersion: string;
  /** Short description of what was done */
  fixDescription: string;
  /** The plan text used to implement the fix */
  planText: string;
  /** The diff that was applied */
  diff: string;
  /** Repos+PRs where this fix has been applied */
  appliedTo: Array<{ repo: string; prNumber: string; timestamp: number }>;
  /** When the fix was first recorded */
  createdAt: number;
  /** Optional: regex pattern to match against CI error logs */
  errorPattern?: string;
}

export interface FixSuggestion {
  entry: FixRegistryEntry;
  confidence: "high" | "medium";
  reason: string;
}

// ── Storage ─────────────────────────────────────────────────────────────────

const REGISTRY_DIR = path.join(os.homedir(), ".dependabot-dashboard");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "fix-registry.json");

let registry: FixRegistryEntry[] = [];

function loadRegistry(): void {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = fs.readFileSync(REGISTRY_FILE, "utf8");
      registry = JSON.parse(raw);
    }
  } catch {
    registry = [];
  }
}

function saveRegistry(): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf8");
}

// Load on module init
loadRegistry();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a successful fix in the registry.
 * Extracts dependency info from the diff to build the registry entry.
 */
export function recordFix(opts: {
  repo: string;
  prNumber: string;
  diff: string;
  planText?: string;
}): FixRegistryEntry | null {
  const { repo, prNumber, diff, planText } = opts;
  const depChange = extractDependencyChange(diff);
  if (!depChange) return null;

  // Check if we already have an entry for this exact dependency+brokenVersion
  const existing = registry.find(
    (e) =>
      e.dependencyName === depChange.name &&
      e.brokenVersion === depChange.brokenVersion,
  );

  if (existing) {
    // Just add this repo to the appliedTo list
    const alreadyApplied = existing.appliedTo.some(
      (a) => a.repo === repo && a.prNumber === prNumber,
    );
    if (!alreadyApplied) {
      existing.appliedTo.push({
        repo,
        prNumber,
        timestamp: Date.now(),
      });
    }
    saveRegistry();
    return existing;
  }

  // Create new entry
  const entry: FixRegistryEntry = {
    id: `${depChange.name}@${depChange.brokenVersion}->${depChange.fixedVersion}`,
    dependencyName: depChange.name,
    brokenVersion: depChange.brokenVersion,
    fixedVersion: depChange.fixedVersion,
    fixDescription: `Revert ${depChange.name} from ${depChange.brokenVersion} to ${depChange.fixedVersion}`,
    planText: planText ?? "",
    diff,
    appliedTo: [{ repo, prNumber, timestamp: Date.now() }],
    createdAt: Date.now(),
  };

  registry.push(entry);
  saveRegistry();
  return entry;
}

/**
 * Find matching fixes for a PR based on its title (which contains the dep name/version).
 * Dependabot PR titles follow the pattern:
 *   "Bump <package> from <old> to <new>"
 *   "Bump the <group> group across N directories with N updates"
 */
export function findMatchingFixes(prTitle: string): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];

  for (const entry of registry) {
    // Check if the PR title mentions the same dependency and broken version
    const depInTitle =
      prTitle.toLowerCase().includes(entry.dependencyName.toLowerCase()) &&
      prTitle.includes(entry.brokenVersion.replace(/[\^~]/, ""));

    // For grouped bumps, check if the diff contains the same dep upgrade
    const groupBump = /bump the .* group/i.test(prTitle);

    if (depInTitle) {
      suggestions.push({
        entry,
        confidence: "high",
        reason: `Same dependency upgrade (${entry.dependencyName} to ${entry.brokenVersion}) was fixed in ${entry.appliedTo[0].repo}#${entry.appliedTo[0].prNumber}`,
      });
    } else if (groupBump && prTitle.toLowerCase().includes("dev-deps")) {
      // For grouped dev-dep bumps, check if any known fix dependency might be in this group
      // This is lower confidence — the actual deps need to be checked
      suggestions.push({
        entry,
        confidence: "medium",
        reason: `Grouped dev-deps bump may include ${entry.dependencyName}@${entry.brokenVersion} — previously fixed in ${entry.appliedTo[0].repo}#${entry.appliedTo[0].prNumber}`,
      });
    }
  }

  return suggestions;
}

/**
 * Find matching fixes by examining the actual dependency diff content.
 * More accurate than title matching for grouped bumps.
 */
export function findMatchingFixesByDiff(diffContent: string): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];

  for (const entry of registry) {
    // Check if this diff contains the same dep being bumped to the same broken version
    const escapedName = entry.dependencyName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const escapedVersion = entry.brokenVersion
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match lines like: +    "typescript": "^7.0.2",
    const pattern = new RegExp(
      `\\+.*"${escapedName}"\\s*:\\s*"${escapedVersion}"`,
    );

    if (pattern.test(diffContent)) {
      suggestions.push({
        entry,
        confidence: "high",
        reason: `This PR upgrades ${entry.dependencyName} to ${entry.brokenVersion}, which was previously fixed by reverting to ${entry.fixedVersion} in ${entry.appliedTo[0].repo}#${entry.appliedTo[0].prNumber}`,
      });
    }
  }

  return suggestions;
}

/**
 * Get all entries in the registry.
 */
export function getAllFixes(): FixRegistryEntry[] {
  return [...registry];
}

/**
 * Remove an entry from the registry (e.g., when the upstream issue is resolved).
 */
export function removeFix(id: string): boolean {
  const before = registry.length;
  registry = registry.filter((e) => e.id !== id);
  if (registry.length < before) {
    saveRegistry();
    return true;
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DependencyChange {
  name: string;
  brokenVersion: string;
  fixedVersion: string;
}

/**
 * Extract the primary dependency change from a patch diff.
 * Looks for package.json changes where a version was reverted/changed.
 */
function extractDependencyChange(diff: string): DependencyChange | null {
  // Look for lines like:
  // -    "typescript": "^7.0.2",
  // +    "typescript": "^6.0.3",
  const lines = diff.split("\n");
  let inPackageJson = false;
  const removals: Array<{ name: string; version: string }> = [];
  const additions: Array<{ name: string; version: string }> = [];

  for (const line of lines) {
    if (line.startsWith("diff --git") && line.includes("package.json")) {
      inPackageJson = true;
      continue;
    }
    if (line.startsWith("diff --git") && !line.includes("package.json")) {
      inPackageJson = false;
      continue;
    }
    if (!inPackageJson) continue;

    const depMatch = line.match(
      /^([+-])\s*"(@?[^"]+)"\s*:\s*"([^"]+)"/,
    );
    if (depMatch) {
      const [, sign, name, version] = depMatch;
      if (sign === "-") removals.push({ name, version });
      else additions.push({ name, version });
    }
  }

  // Find a dep that was changed (present in both removals and additions)
  for (const removed of removals) {
    const added = additions.find((a) => a.name === removed.name);
    if (added && removed.version !== added.version) {
      // The "broken" version is whichever came from Dependabot (the removal in our fix diff)
      // The "fixed" version is what we reverted to (the addition in our fix diff)
      return {
        name: removed.name,
        brokenVersion: removed.version,
        fixedVersion: added.version,
      };
    }
  }

  return null;
}

// ── Router ──────────────────────────────────────────────────────────────────

const router = Router();

/** Get all fix registry entries */
router.get("/dependabot-fix-registry", (_req: Request, res: Response) => {
  res.json({ entries: getAllFixes() });
});

/** Check for matching fixes for a specific PR */
router.get(
  "/dependabot-fix-suggestions",
  (req: Request, res: Response) => {
    const { prTitle } = req.query as { prTitle?: string };
    if (!prTitle) {
      res.status(400).json({ error: "Missing prTitle" });
      return;
    }
    const suggestions = findMatchingFixes(prTitle);
    res.json({ suggestions });
  },
);

/** Remove an entry from the registry */
router.post(
  "/dependabot-fix-registry-remove",
  (req: Request, res: Response) => {
    const { id } = req.body as { id?: string };
    if (!id) {
      res.status(400).json({ error: "Missing id" });
      return;
    }
    const removed = removeFix(id);
    res.json({ success: removed });
  },
);

export default router;
