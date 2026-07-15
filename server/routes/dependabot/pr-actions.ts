import { Router, Request, Response } from "express";
import { execFile, runCommand, BREW_PATH } from "../helpers.js";
import { GITHUB_ORG, getRepoCache, isKnownRepo } from "./teams-cache.js";
import { fetchDependabotPrsForRepo } from "./pr-fetching.js";

const router = Router();

/** Validate that prNumber is a safe positive integer string */
function isValidPrNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,10}$/.test(value) && parseInt(value, 10) > 0;
}

/** Validate that repo is a safe repo name (alphanumeric, hyphens, underscores, dots only) */
function isValidRepoName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(value);
}

// ── PR listing and actions ──────────────────────────────────────────────────

router.get("/dependabot-teams", async (_req: Request, res: Response) => {
  try {
    const cache = await getRepoCache();
    const teams = Object.entries(cache.categories).map(([name, repos]) => ({
      name,
      repoCount: repos.length,
    }));
    res.json({ teams });
  } catch (err) {
    console.error("[dependabot] Failed to fetch teams:", err);
    res.status(500).json({ error: "Failed to fetch teams from GitHub" });
  }
});

router.get("/dependabot-categories", async (req: Request, res: Response) => {
  try {
    const cache = await getRepoCache();
    const { teams: teamsParam } = req.query as { teams?: string };

    // If teams filter is provided, only return those categories
    if (teamsParam) {
      const selectedTeams = teamsParam.split(",").map((t) => t.trim()).filter(Boolean);
      const filtered: Record<string, string[]> = {};
      for (const team of selectedTeams) {
        if (cache.categories[team]) {
          filtered[team] = cache.categories[team];
        }
      }
      res.json(filtered);
      return;
    }

    res.json(cache.categories);
  } catch (err) {
    console.error("[dependabot] Failed to fetch categories:", err);
    res.status(500).json({ error: "Failed to fetch team/repo data from GitHub" });
  }
});

router.get("/dependabot-prs", async (req: Request, res: Response) => {
  const { repo: repoParam, teams: teamsParam } = req.query as { repo?: string; teams?: string };
  const cache = await getRepoCache();

  let allRepos: string[];
  if (teamsParam) {
    const selectedTeams = teamsParam.split(",").map((t) => t.trim()).filter(Boolean);
    allRepos = [
      ...new Set(
        selectedTeams.flatMap((team) => cache.categories[team] ?? []),
      ),
    ];
  } else {
    allRepos = cache.allRepos;
  }

  const repos =
    repoParam && allRepos.includes(repoParam)
      ? [repoParam]
      : allRepos;
  const results = await Promise.all(repos.map(fetchDependabotPrsForRepo));
  res.json(results);
});

// Fetch failed step details for a PR's check runs
router.get(
  "/dependabot-check-failures",
  async (req: Request, res: Response) => {
    const { repo, prNumber } = req.query as {
      repo?: string;
      prNumber?: string;
    };
    if (!repo || !prNumber) {
      res.status(400).json({ error: "repo and prNumber are required" });
      return;
    }
    if (!isValidPrNumber(prNumber) || !isValidRepoName(repo)) {
      res.status(400).json({ error: "Invalid repo or prNumber" });
      return;
    }
    if (!(await isKnownRepo(repo))) {
      res.status(400).json({ error: "Unknown repository" });
      return;
    }
    try {
      // Get the head SHA for this PR
      const prResult = await runCommand(
        `gh pr view ${prNumber} --repo ${GITHUB_ORG}/${repo} --json headRefOid --jq '.headRefOid'`,
      );
      if (!prResult.ok) {
        res.json({ failures: [] });
        return;
      }
      const sha = prResult.stdout.trim();

      // Fetch check runs for the commit
      const checksResult = await runCommand(
        `gh api repos/${GITHUB_ORG}/${repo}/commits/${sha}/check-runs --jq '.check_runs[] | select(.conclusion == "failure") | {name: .name, html_url: .html_url, output_title: .output.title, output_summary: .output.summary}'`,
      );

      if (!checksResult.ok || !checksResult.stdout.trim()) {
        // Fallback: try status checks via gh pr checks
        const fallbackResult = await runCommand(
          `gh pr checks ${prNumber} --repo ${GITHUB_ORG}/${repo} --json name,state,bucket,link`,
        );
        if (fallbackResult.ok) {
          const checks = JSON.parse(fallbackResult.stdout) as Array<{
            name: string;
            state: string;
            bucket: string;
            link: string;
          }>;
          const failures = checks
            .filter((c) => c.bucket === "fail")
            .map((c) => ({
              name: c.name,
              link: c.link || "",
              summary: `Check concluded with state: ${c.state}`,
            }));
          res.json({ failures });
          return;
        }
        res.json({ failures: [] });
        return;
      }

      // Parse NDJSON output (one JSON object per line)
      const failures = checksResult.stdout
        .trim()
        .split("\n")
        .map((line) => {
          try {
            const obj = JSON.parse(line) as {
              name: string;
              html_url: string;
              output_title: string;
              output_summary: string;
            };
            return {
              name: obj.name,
              link: obj.html_url || "",
              summary:
                obj.output_title ||
                (obj.output_summary
                  ? obj.output_summary.slice(0, 300)
                  : "Failed"),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      res.json({ failures });
    } catch (err) {
      console.warn("[dependabot] check-failures error:", err);
      res.json({ failures: [] });
    }
  },
);

router.post("/dependabot-approve-pr", async (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo: string; prNumber: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const prNumberStr = String(prNumber);
  if (!isValidPrNumber(prNumberStr) || !isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }
  execFile(
    "gh",
    ["pr", "review", prNumberStr, "--repo", `${GITHUB_ORG}/${repo}`, "--approve"],
    { env: { ...process.env, PATH: BREW_PATH } },
    (error: Error | null, _stdout: string, stderr: string) => {
      if (error) {
        res.status(500).json({ error: stderr || error.message });
        return;
      }
      res.json({ success: true });
    },
  );
});

router.post("/dependabot-merge-pr", async (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo: string; prNumber: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const prNumberStr = String(prNumber);
  if (!isValidPrNumber(prNumberStr) || !isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }
  execFile(
    "gh",
    ["pr", "merge", prNumberStr, "--repo", `${GITHUB_ORG}/${repo}`, "--squash", "--auto"],
    { env: { ...process.env, PATH: BREW_PATH } },
    (error: Error | null, _stdout: string, stderr: string) => {
      if (error) {
        res.status(500).json({ error: stderr || error.message });
        return;
      }
      res.json({ success: true });
    },
  );
});

router.post("/dependabot-update-branch", async (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo: string; prNumber: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const prNumberStr = String(prNumber);
  if (!isValidPrNumber(prNumberStr) || !isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }
  execFile(
    "gh",
    ["pr", "comment", prNumberStr, "--repo", `${GITHUB_ORG}/${repo}`, "--body", "@dependabot rebase"],
    { env: { ...process.env, PATH: BREW_PATH } },
    (error: Error | null, _stdout: string, stderr: string) => {
      if (error) {
        res.status(500).json({ error: stderr || error.message });
        return;
      }
      res.json({ success: true });
    },
  );
});

router.post("/dependabot-recreate-pr", async (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo: string; prNumber: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const prNumberStr = String(prNumber);
  if (!isValidPrNumber(prNumberStr) || !isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }
  execFile(
    "gh",
    ["pr", "comment", prNumberStr, "--repo", `${GITHUB_ORG}/${repo}`, "--body", "@dependabot recreate"],
    { env: { ...process.env, PATH: BREW_PATH } },
    (error, _stdout, stderr) => {
      if (error) {
        res.status(500).json({ error: stderr || error.message });
      } else {
        res.json({ success: true });
      }
    },
  );
});

router.post("/dependabot-delete-branch", async (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo: string; prNumber: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const prNumberStr = String(prNumber);
  if (!isValidPrNumber(prNumberStr) || !isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }
  execFile(
    "gh",
    ["pr", "close", prNumberStr, "--repo", `${GITHUB_ORG}/${repo}`, "--delete-branch"],
    { env: { ...process.env, PATH: BREW_PATH } },
    (error, _stdout, stderr) => {
      if (error) {
        res.status(500).json({ error: stderr || error.message });
      } else {
        res.json({ success: true });
      }
    },
  );
});

export default router;
