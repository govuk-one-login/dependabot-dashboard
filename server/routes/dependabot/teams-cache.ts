import { runCommand } from "../helpers.js";

export const GITHUB_ORG = "govuk-one-login";

// ── Dynamic team/repo fetching with cache ────────────────────────────────────

export interface RepoCache {
  categories: Record<string, string[]>;
  allRepos: string[];
  fetchedAt: number;
}

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let repoCache: RepoCache | null = null;
let repoCachePromise: Promise<RepoCache> | null = null;

const EXCLUDED_TEAMS = ["govuk-one-login-all"];

export async function fetchTeamsAndRepos(): Promise<RepoCache> {
  // Get all teams for the authenticated user
  const teamsResult = await runCommand(
    `gh api /user/teams --paginate --jq '[.[] | select(.organization.login == "${GITHUB_ORG}") | {name: .name, slug: .slug}]'`,
  );

  if (!teamsResult.ok || !teamsResult.stdout.trim()) {
    console.warn(
      "[dependabot] Failed to fetch teams:",
      teamsResult.stderr || "empty response",
    );
    return { categories: {}, allRepos: [], fetchedAt: Date.now() };
  }

  let teams: Array<{ name: string; slug: string }>;
  try {
    // gh api --paginate with --jq that outputs arrays will output multiple JSON arrays
    // (one per page), so we need to handle both single array and concatenated arrays
    const raw = teamsResult.stdout.trim();
    if (raw.startsWith("[")) {
      // Could be multiple arrays concatenated: ][
      const merged = raw.replace(/\]\s*\[/g, ",");
      teams = JSON.parse(merged);
    } else {
      teams = [];
    }
  } catch (err) {
    console.warn("[dependabot] Failed to parse teams JSON:", err);
    return { categories: {}, allRepos: [], fetchedAt: Date.now() };
  }

  // Filter out org-wide teams that aren't useful for categorisation
  teams = teams.filter((t) => !EXCLUDED_TEAMS.includes(t.slug));

  if (teams.length === 0) {
    console.warn(
      `[dependabot] No teams found for org "${GITHUB_ORG}". Ensure your token has read:org scope.`,
    );
    return { categories: {}, allRepos: [], fetchedAt: Date.now() };
  }

  // Fetch repos for each team in parallel
  const categories: Record<string, string[]> = {};
  await Promise.all(
    teams.map(async (team) => {
      const reposResult = await runCommand(
        `gh api /orgs/${GITHUB_ORG}/teams/${team.slug}/repos --paginate --jq '.[].name'`,
      );
      if (reposResult.ok && reposResult.stdout.trim()) {
        const repos = reposResult.stdout
          .trim()
          .split("\n")
          .filter((r) => r.length > 0);
        if (repos.length > 0) {
          categories[team.name] = repos;
        }
      }
    }),
  );

  const allRepos = [...new Set(Object.values(categories).flat())];
  console.log(
    `[dependabot] Fetched ${teams.length} teams, ${allRepos.length} unique repos from GitHub`,
  );

  return { categories, allRepos, fetchedAt: Date.now() };
}

export async function getRepoCache(): Promise<RepoCache> {
  // Return cached data if still fresh
  if (repoCache && Date.now() - repoCache.fetchedAt < CACHE_TTL_MS) {
    return repoCache;
  }

  // Deduplicate concurrent requests
  if (repoCachePromise) {
    return repoCachePromise;
  }

  repoCachePromise = fetchTeamsAndRepos()
    .then((result) => {
      repoCache = result;
      repoCachePromise = null;
      return result;
    })
    .catch((err) => {
      console.error("[dependabot] Error fetching teams/repos:", err);
      repoCachePromise = null;
      // Return stale cache if available, otherwise empty
      if (repoCache) return repoCache;
      return { categories: {}, allRepos: [], fetchedAt: 0 };
    });

  return repoCachePromise;
}

// Helper to get the flat repos list (used for validation)
export async function getDependabotRepos(): Promise<string[]> {
  const cache = await getRepoCache();
  return cache.allRepos;
}

// Helper to check if a repo is in the known set
export async function isKnownRepo(repo: string): Promise<boolean> {
  const repos = await getDependabotRepos();
  return repos.includes(repo);
}
