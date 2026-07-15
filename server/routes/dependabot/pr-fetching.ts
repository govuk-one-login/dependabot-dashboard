import { exec, runCommand, BREW_PATH } from "../helpers.js";
import { GITHUB_ORG } from "./teams-cache.js";

export interface GhPr {
  number: number;
  title: string;
  url: string;
  body: string;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
}

export type BuildStatus = "green" | "amber" | "red" | "unknown";

export interface GhCheck {
  name: string;
  state: string;
  bucket: string;
}

export function deriveBuildStatus(checks: GhCheck[]): BuildStatus {
  if (checks.length === 0) return "unknown";
  const relevant = checks.filter((c) => c.bucket !== "skipping");
  if (relevant.length === 0) return "unknown";
  if (relevant.some((c) => c.bucket === "fail")) return "red";
  if (relevant.some((c) => c.bucket === "pending")) return "amber";
  return "green";
}

export interface BuildInfo {
  status: BuildStatus;
  failedChecks: string[];
}

export function fetchBuildInfoForPr(
  repo: string,
  prNumber: number,
): Promise<BuildInfo> {
  return new Promise((resolve) => {
    const cmd = `gh pr checks ${prNumber} --repo ${GITHUB_ORG}/${repo} --json name,state,bucket`;
    exec(
      cmd,
      { shell: "/bin/sh" },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          console.warn(
            `[dependabot] build-status fetch failed for ${repo}#${prNumber}: ${stderr || error.message}`,
          );
          resolve({ status: "unknown", failedChecks: [] });
          return;
        }
        try {
          const checks: GhCheck[] = JSON.parse(stdout);
          const status = deriveBuildStatus(checks);
          const failedChecks = checks
            .filter((c) => c.bucket === "fail")
            .map((c) => c.name);
          const checkSummary = checks
            .map((c) => c.name + "=" + c.bucket)
            .join(", ");
          console.log(
            `[dependabot] ${repo}#${prNumber} → ${status} (${checks.length} checks: ${checkSummary})`,
          );
          resolve({ status, failedChecks });
        } catch (parseErr) {
          console.warn(
            `[dependabot] failed to parse checks JSON for ${repo}#${prNumber}:`,
            parseErr,
            "stdout:",
            stdout,
          );
          resolve({ status: "unknown", failedChecks: [] });
        }
      },
    );
  });
}

export interface ApprovalInfo {
  myApproved: boolean;
  approvalCount: number;
  approvalsRequired: number;
  reviewDecision: string;
}

let cachedGhUser: string | null = null;
export async function getCurrentGhUser(): Promise<string | null> {
  if (cachedGhUser !== null) return cachedGhUser;
  const result = await runCommand("gh api user --jq '.login'");
  cachedGhUser = result.ok && result.stdout ? result.stdout : null;
  return cachedGhUser;
}

const requiredApprovalsCache = new Map<string, number>();
export async function fetchRequiredApprovals(
  repo: string,
  branch: string,
): Promise<number> {
  const cacheKey = `${repo}/${branch}`;
  if (requiredApprovalsCache.has(cacheKey))
    return requiredApprovalsCache.get(cacheKey)!;
  const result = await runCommand(
    `gh api repos/${GITHUB_ORG}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews --jq '.required_approving_review_count' 2>/dev/null`,
  );
  const count = Number.parseInt(result.stdout, 10);
  const required = Number.isNaN(count) ? 1 : count;
  requiredApprovalsCache.set(cacheKey, required);
  return required;
}

export async function fetchApprovalInfoForPr(
  repo: string,
  prNumber: number,
  baseBranch: string,
): Promise<ApprovalInfo> {
  const [currentUser, prData, approvalsRequired] = await Promise.all([
    getCurrentGhUser(),
    runCommand(
      `gh pr view ${prNumber} --repo ${GITHUB_ORG}/${repo} --json reviews,reviewDecision`,
    ),
    fetchRequiredApprovals(repo, baseBranch),
  ]);

  if (!prData.ok) {
    return {
      myApproved: false,
      approvalCount: 0,
      approvalsRequired,
      reviewDecision: "",
    };
  }

  try {
    const data = JSON.parse(prData.stdout) as {
      reviews: Array<{ author: { login: string } | null; state: string }>;
      reviewDecision: string;
    };
    const approvedReviews = (data.reviews ?? []).filter(
      (r) => r.state === "APPROVED",
    );
    const myApproved =
      currentUser !== null &&
      approvedReviews.some((r) => r.author?.login === currentUser);
    return {
      myApproved,
      approvalCount: approvedReviews.length,
      approvalsRequired,
      reviewDecision: data.reviewDecision ?? "",
    };
  } catch {
    return {
      myApproved: false,
      approvalCount: 0,
      approvalsRequired,
      reviewDecision: "",
    };
  }
}

export function fetchIsBehindForPr(
  repo: string,
  base: string,
  head: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      `gh api repos/${GITHUB_ORG}/${repo}/compare/${base}...${head} --jq '.behind_by'`,
      { shell: "/bin/sh", env: { ...process.env, PATH: BREW_PATH } },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          console.warn(
            `[dependabot] compare check failed for ${repo} ${base}...${head}:`,
            stderr || error.message,
          );
          resolve(false);
          return;
        }
        const behindBy = Number.parseInt(stdout.trim(), 10);
        resolve(!Number.isNaN(behindBy) && behindBy > 0);
      },
    );
  });
}

export function fetchDependabotPrsForRepo(
  repo: string,
): Promise<{ repo: string; prs: any[]; error?: string }> {
  return new Promise((resolve) => {
    exec(
      `gh pr list --repo ${GITHUB_ORG}/${repo} --state open --json number,title,url,body,author,baseRefName,headRefName --limit 100`,
      { shell: "/bin/sh" },
      async (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve({ repo, prs: [], error: stderr || error.message });
          return;
        }
        try {
          const all: GhPr[] = JSON.parse(stdout);
          const filtered = all.filter(
            (pr) =>
              pr.title.toLowerCase().includes("dependabot") ||
              (pr.author?.login ?? "").toLowerCase().includes("dependabot"),
          );
          const prs = await Promise.all(
            filtered.map(
              async ({
                number,
                title,
                url,
                body,
                baseRefName,
                headRefName,
              }) => {
                const [buildInfo, isBehind, approvalInfo] = await Promise.all([
                  fetchBuildInfoForPr(repo, number),
                  fetchIsBehindForPr(repo, baseRefName, headRefName),
                  fetchApprovalInfoForPr(repo, number, baseRefName),
                ]);
                return {
                  number,
                  title,
                  url,
                  body,
                  buildStatus: buildInfo.status,
                  failedChecks: buildInfo.failedChecks,
                  isBehind,
                  ...approvalInfo,
                };
              },
            ),
          );
          resolve({ repo, prs });
        } catch {
          resolve({ repo, prs: [], error: "Failed to parse gh output" });
        }
      },
    );
  });
}
