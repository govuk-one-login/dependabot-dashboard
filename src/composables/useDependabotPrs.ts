import { ref, computed, watch, reactive } from "vue";
import type { ActionState, PrStatus } from "@/types/dependabot";
import { createActionState } from "@/types/dependabot";

// ── Data types (from API) ───────────────────────────────────────────
export interface PrItem {
  number: number;
  title: string;
  url: string;
  body: string;
  buildStatus: "green" | "amber" | "red" | "unknown";
  failedChecks: string[];
  isBehind: boolean;
  myApproved: boolean;
  approvalCount: number;
  approvalsRequired: number;
  reviewDecision: string;
}

export interface RepoResult {
  repo: string;
  prs: PrItem[];
  error?: string;
}

// ── Agent config type ───────────────────────────────────────────────
export type AgentMode = "kiro" | "ollama";
export interface AgentConfig {
  agent: AgentMode;
  model: string;
}

export function useDependabotPrs(
  notifyUser: (title: string, body: string) => void,
) {
  // ── State ───────────────────────────────────────────────────────────
  const agentConfig = ref<AgentConfig>({ agent: "kiro", model: "codellama" });
  const categories = ref<Record<string, string[]>>({});
  const results = ref<RepoResult[]>([]);
  const loading = ref(false);
  const fetchError = ref<string | null>(null);
  const lastFetched = ref<Date | null>(null);

  // Tree state
  const expandedCategories = reactive<Record<string, boolean>>({});
  const expandedRepos = reactive<Record<string, boolean>>({});
  const selectedPrId = ref<string | null>(null);

  // Action states
  const actionStates = reactive<Record<string, ActionState>>({});

  function stateFor(repo: string, prNumber: number): ActionState {
    const key = `${repo}#${prNumber}`;
    if (!actionStates[key]) {
      actionStates[key] = createActionState();
    }
    return actionStates[key];
  }

  // ── Stats ───────────────────────────────────────────────────────────
  const allPrs = computed(() => results.value.flatMap((r) => r.prs));
  const totalPrCount = computed(() => allPrs.value.length);
  const failingCount = computed(
    () => allPrs.value.filter((p) => p.buildStatus === "red").length,
  );
  const passingCount = computed(
    () => allPrs.value.filter((p) => p.buildStatus === "green").length,
  );
  const pendingCount = computed(
    () => allPrs.value.filter((p) => p.buildStatus === "amber").length,
  );
  const outdatedCount = computed(
    () => allPrs.value.filter((p) => p.isBehind).length,
  );
  const readyToMergeCount = computed(
    () =>
      allPrs.value.filter(
        (p) =>
          p.buildStatus === "green" &&
          !p.isBehind &&
          p.reviewDecision === "APPROVED",
      ).length,
  );
  const awaitingReviewCount = computed(
    () =>
      allPrs.value.filter(
        (p) =>
          p.buildStatus === "green" &&
          !p.isBehind &&
          p.reviewDecision !== "APPROVED" &&
          p.approvalCount === 0,
      ).length,
  );
  const secondaryReviewCount = computed(
    () =>
      allPrs.value.filter(
        (p) => p.approvalCount > 0 && p.approvalCount < p.approvalsRequired,
      ).length,
  );
  const reposWithPrsCount = computed(
    () => results.value.filter((r) => r.prs.length > 0).length,
  );
  const repoErrorCount = computed(
    () => results.value.filter((r) => r.error).length,
  );

  // ── Tree data structure ─────────────────────────────────────────────
  function prStatusFromItem(pr: PrItem): PrStatus {
    if (pr.buildStatus === "red") return "failing";
    if (pr.isBehind) return "outdated";
    return "passing";
  }

  const treeCategories = computed(() => {
    const entries = Object.entries(categories.value);
    return entries.map(([name, repos]) => ({
      name,
      expanded: expandedCategories[name] !== false, // default open
      repos: repos.map((repoName) => {
        const result = results.value.find((r) => r.repo === repoName);
        return {
          name: repoName,
          expanded: expandedRepos[repoName] ?? false,
          error: !!result?.error,
          prs: (result?.prs ?? []).map((pr) => ({
            number: pr.number,
            title: pr.title,
            status: prStatusFromItem(pr),
          })),
        };
      }),
    }));
  });

  // ── Selected PR details ─────────────────────────────────────────────
  const selectedRepo = computed(() => {
    if (!selectedPrId.value) return null;
    return selectedPrId.value.split("#")[0];
  });

  const selectedPrNumber = computed(() => {
    if (!selectedPrId.value) return null;
    return Number.parseInt(selectedPrId.value.split("#")[1], 10);
  });

  const selectedPr = computed(() => {
    if (!selectedRepo.value || !selectedPrNumber.value) return null;
    const result = results.value.find((r) => r.repo === selectedRepo.value);
    return (
      result?.prs.find((pr) => pr.number === selectedPrNumber.value) ?? null
    );
  });

  const selectedState = computed(() => {
    if (!selectedRepo.value || !selectedPrNumber.value) return null;
    return stateFor(selectedRepo.value, selectedPrNumber.value);
  });

  // ── Tree interactions ───────────────────────────────────────────────
  function toggleCategory(name: string) {
    expandedCategories[name] = !expandedCategories[name];
  }

  function toggleRepo(repoName: string) {
    expandedRepos[repoName] = !expandedRepos[repoName];
  }

  function selectPr(repo: string, prNumber: number) {
    selectedPrId.value = `${repo}#${prNumber}`;
    // Auto-expand the repo if collapsed
    if (!expandedRepos[repo]) {
      expandedRepos[repo] = true;
    }
  }

  // Auto-select first PR on load
  function autoSelectFirstPr(newResults: RepoResult[]) {
    if (selectedPrId.value || !newResults.length) return;
    const first = newResults.find((r) => r.prs.length > 0);
    if (!first) return;
    selectedPrId.value = `${first.repo}#${first.prs[0].number}`;
    expandedRepos[first.repo] = true;
    const catEntry = Object.entries(categories.value).find(([, repos]) =>
      repos.includes(first.repo),
    );
    if (catEntry) expandedCategories[catEntry[0]] = true;
  }

  watch(results, autoSelectFirstPr, { immediate: true });

  // Default expand all categories
  watch(
    categories,
    (cats) => {
      for (const name of Object.keys(cats)) {
        if (expandedCategories[name] === undefined) {
          expandedCategories[name] = true;
        }
      }
    },
    { immediate: true },
  );

  // ── API calls ───────────────────────────────────────────────────────
  async function fetchPrs() {
    loading.value = true;
    fetchError.value = null;

    try {
      // Read selected teams from localStorage (set by DependabotPreflight)
      let teamsParam = "";
      try {
        const storedTeams = localStorage.getItem("dependabotSelectedTeams");
        if (storedTeams) {
          const teams = JSON.parse(storedTeams) as string[];
          if (teams.length > 0) {
            teamsParam = teams.join(",");
          }
        }
      } catch {
        // ignore — fetch all teams
      }

      const catUrl = teamsParam
        ? `/api/dependabot-categories?teams=${encodeURIComponent(teamsParam)}`
        : "/api/dependabot-categories";
      const prUrl = teamsParam
        ? `/api/dependabot-prs?teams=${encodeURIComponent(teamsParam)}`
        : "/api/dependabot-prs";

      const [catRes, prRes] = await Promise.all([fetch(catUrl), fetch(prUrl)]);
      if (!catRes.ok) throw new Error(`Categories: ${catRes.status}`);
      if (!prRes.ok) throw new Error(`PRs: ${prRes.status}`);
      categories.value = await catRes.json();
      results.value = await prRes.json();
      lastFetched.value = new Date();
    } catch (err: unknown) {
      fetchError.value = err instanceof Error ? err.message : "Unknown error";
    } finally {
      loading.value = false;
    }
  }

  // ── PR Actions ──────────────────────────────────────────────────────
  async function approvePr(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.approving = true;
    state.approveError = null;
    try {
      const res = await fetch("/api/dependabot-approve-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, prNumber }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.approveError = data.error ?? `Server error ${res.status}`;
      } else {
        state.approved = true;
      }
    } catch (err: unknown) {
      state.approveError = err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.approving = false;
    }
  }

  async function mergePr(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.merging = true;
    state.mergeError = null;
    try {
      const res = await fetch("/api/dependabot-merge-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, prNumber }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.mergeError = data.error ?? `Server error ${res.status}`;
      } else {
        state.merged = true;
      }
    } catch (err: unknown) {
      state.mergeError = err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.merging = false;
    }
  }

  async function updateBranch(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.updating = true;
    state.updateError = null;
    try {
      const res = await fetch("/api/dependabot-update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, prNumber }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.updateError = data.error ?? `Server error ${res.status}`;
      } else {
        state.updated = true;
      }
    } catch (err: unknown) {
      state.updateError = err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.updating = false;
    }
  }

  // Track open EventSources
  const activeEventSources = new Map<string, EventSource>();

  async function stopFix(repo: string, prNumber: number) {
    const key = `${repo}#${prNumber}`;
    const state = stateFor(repo, prNumber);
    state.stopping = true;
    activeEventSources.get(key)?.close();
    activeEventSources.delete(key);
    await fetch("/api/dependabot-stop-fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, prNumber }),
    }).catch(() => {});
    state.fixing = false;
    state.planning = false;
    state.stopping = false;
    state.fixLog = [];
    state.planLog = [];
    state.fixSummary = "";
    state.showFixLog = false;
    state.fixError = null;
    state.planError = null;
    state.pendingJobId = null;
    state.pendingPlanJobId = null;
    state.fixDiff = "";
    state.planText = "";
  }

  // ── Plan → execute flow ─────────────────────────────────────────────

  function openPlanEventSource(
    repo: string,
    prNumber: number,
    endpoint: string,
    params: URLSearchParams,
  ) {
    const key = `${repo}#${prNumber}`;
    const state = stateFor(repo, prNumber);
    const source = new EventSource(`${endpoint}?${params.toString()}`);
    activeEventSources.set(key, source);

    source.addEventListener("log", (e: MessageEvent) => {
      const line: string = JSON.parse(e.data);
      line.split("\n").forEach((l) => {
        if (l.trim()) state.planLog.push(l);
      });
    });

    source.addEventListener("plan", (e: MessageEvent) => {
      state.planText = JSON.parse(e.data) as string;
    });

    source.addEventListener("done", (e: MessageEvent) => {
      const outcome: string = JSON.parse(e.data);
      source.close();
      activeEventSources.delete(key);
      state.planning = false;
      if (outcome.startsWith("needs-execution:")) {
        state.pendingPlanJobId = outcome.slice("needs-execution:".length);
        state.showPlanLog = false;
        notifyUser(
          `📋 Plan ready — ${repo}#${prNumber}`,
          `Review the plan for ${repo} PR #${prNumber} before the fix is applied.`,
        );
      } else {
        state.planError = "Planning failed — see log below";
        state.showPlanLog = true;
        notifyUser(
          `❌ Planning failed — ${repo}#${prNumber}`,
          `Kiro could not produce a plan for ${repo} PR #${prNumber}.`,
        );
      }
    });

    source.addEventListener("error", () => {
      source.close();
      activeEventSources.delete(key);
      if (state.stopping) return;
      state.planning = false;
      state.planError = "Connection lost — server may have restarted";
      state.showPlanLog = true;
    });
  }

  async function planWithAi(
    repo: string,
    prNumber: number,
    extraInstructions?: string,
  ) {
    const state = stateFor(repo, prNumber);
    state.planning = true;
    state.stopping = false;
    state.planError = null;
    state.planLog = [];
    state.planText = "";
    state.showPlanLog = false;
    state.pendingPlanJobId = null;
    state.showReplanInput = false;
    state.replanComment = "";
    state.discarded = false;

    const params = new URLSearchParams({ repo, prNumber: String(prNumber) });
    if (extraInstructions) params.set("extraInstructions", extraInstructions);
    openPlanEventSource(repo, prNumber, "/api/dependabot-plan-pr", params);
  }

  async function replanWithComment(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    const planJobId = state.pendingPlanJobId;
    if (!planJobId) return;

    const comment = state.replanComment.trim();
    state.planning = true;
    state.planError = null;
    state.planLog = [];
    state.planText = "";
    state.showPlanLog = false;
    state.pendingPlanJobId = null;
    state.showReplanInput = false;

    const params = new URLSearchParams({ planJobId });
    if (comment) params.set("comment", comment);
    openPlanEventSource(repo, prNumber, "/api/dependabot-replan-pr", params);
  }

  async function executePlan(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    const planJobId = state.pendingPlanJobId;
    if (!planJobId) return;

    state.fixing = true;
    state.stopping = false;
    state.fixError = null;
    state.fixLog = [];
    state.fixSummary = "";
    state.showFixLog = false;
    state.pendingJobId = null;
    state.fixDiff = "";
    state.pushError = null;
    state.pendingPlanJobId = null;

    const key = `${repo}#${prNumber}`;
    const params = new URLSearchParams({ planJobId });
    const source = new EventSource(
      `/api/dependabot-execute-plan?${params.toString()}`,
    );
    activeEventSources.set(key, source);

    source.addEventListener("log", (e: MessageEvent) => {
      const line: string = JSON.parse(e.data);
      line.split("\n").forEach((l) => {
        if (l.trim()) state.fixLog.push(l);
      });
    });
    source.addEventListener("diff", (e: MessageEvent) => {
      state.fixDiff = JSON.parse(e.data) as string;
    });
    source.addEventListener("summary", (e: MessageEvent) => {
      state.fixSummary = JSON.parse(e.data) as string;
    });
    source.addEventListener("done", (e: MessageEvent) => {
      const outcome: string = JSON.parse(e.data);
      source.close();
      activeEventSources.delete(key);
      state.fixing = false;
      if (outcome === "no-changes") {
        state.fixError =
          "Kiro made no changes — the failure may need manual review";
        notifyUser(
          `⚠️ No changes — ${repo}#${prNumber}`,
          `Kiro made no file changes for ${repo} PR #${prNumber}.`,
        );
      } else if (outcome.startsWith("needs-approval:")) {
        state.pendingJobId = outcome.slice("needs-approval:".length);
        state.showFixLog = false;
        notifyUser(
          `🔍 Review changes — ${repo}#${prNumber}`,
          `Kiro has finished. Review the diff for ${repo} PR #${prNumber}.`,
        );
      } else {
        state.fixError = "Fix attempt failed — see log below";
        state.showFixLog = true;
        notifyUser(
          `❌ Fix failed — ${repo}#${prNumber}`,
          `Kiro encountered an error fixing ${repo} PR #${prNumber}.`,
        );
      }
    });
    source.addEventListener("error", () => {
      source.close();
      activeEventSources.delete(key);
      if (state.stopping) return;
      state.fixing = false;
      state.fixError = "Connection lost — server may have restarted";
      state.showFixLog = true;
    });
  }

  async function discardPlan(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    const planJobId = state.pendingPlanJobId;
    state.pendingPlanJobId = null;
    state.planText = "";
    state.discarded = true;
    if (planJobId) {
      await fetch("/api/dependabot-discard-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planJobId }),
      }).catch(() => {});
    }
  }

  async function fixWithAi(
    repo: string,
    prNumber: number,
    extraInstructions?: string,
  ) {
    const state = stateFor(repo, prNumber);
    state.fixing = true;
    state.stopping = false;
    state.fixError = null;
    state.fixLog = [];
    state.fixSummary = "";
    state.showFixLog = false;
    state.pendingJobId = null;
    state.fixDiff = "";
    state.discarded = false;
    state.pushError = null;

    const key = `${repo}#${prNumber}`;
    const isOllama = agentConfig.value.agent === "ollama";
    const endpoint = isOllama
      ? "/api/dependabot-fix-pr-ollama"
      : "/api/dependabot-fix-pr";
    const params = new URLSearchParams({ repo, prNumber: String(prNumber) });
    if (isOllama && agentConfig.value.model) {
      params.set("model", agentConfig.value.model);
    }
    if (extraInstructions) {
      params.set("extraInstructions", extraInstructions);
    }
    const source = new EventSource(`${endpoint}?${params.toString()}`);
    activeEventSources.set(key, source);

    source.addEventListener("log", (e: MessageEvent) => {
      const line: string = JSON.parse(e.data);
      line.split("\n").forEach((l) => {
        if (l.trim()) state.fixLog.push(l);
      });
    });

    source.addEventListener("diff", (e: MessageEvent) => {
      state.fixDiff = JSON.parse(e.data) as string;
    });

    source.addEventListener("summary", (e: MessageEvent) => {
      state.fixSummary = JSON.parse(e.data) as string;
    });

    source.addEventListener("done", (e: MessageEvent) => {
      const outcome: string = JSON.parse(e.data);
      source.close();
      activeEventSources.delete(key);
      state.fixing = false;
      const agentLabel = isOllama
        ? `Ollama (${agentConfig.value.model})`
        : "Kiro";
      if (outcome === "success") {
        state.fixed = true;
        notifyUser(
          `✅ Fix pushed — ${repo}#${prNumber}`,
          `${agentLabel} pushed a fix commit to ${repo} PR #${prNumber}.`,
        );
      } else if (outcome === "no-changes") {
        state.fixError = `${agentLabel} made no changes — the failure may need manual review`;
        notifyUser(
          `⚠️ No changes — ${repo}#${prNumber}`,
          `${agentLabel} made no file changes for ${repo} PR #${prNumber}.`,
        );
      } else if (outcome.startsWith("needs-approval:")) {
        state.pendingJobId = outcome.slice("needs-approval:".length);
        state.showFixLog = false;
        notifyUser(
          `🔍 Review changes — ${repo}#${prNumber}`,
          `${agentLabel} has finished. Review the diff for ${repo} PR #${prNumber} and allow or discard.`,
        );
      } else {
        state.fixError = "Fix attempt failed — see log below";
        state.showFixLog = true;
        notifyUser(
          `❌ Fix failed — ${repo}#${prNumber}`,
          `${agentLabel} encountered an error fixing ${repo} PR #${prNumber}.`,
        );
      }
    });

    source.addEventListener("error", () => {
      source.close();
      activeEventSources.delete(key);
      if (state.stopping) return;
      state.fixing = false;
      state.fixError = "Connection lost — server may have restarted";
      state.showFixLog = true;
    });
  }

  async function pushFix(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.pushing = true;
    state.pushError = null;
    try {
      const res = await fetch("/api/dependabot-push-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: state.pendingJobId }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.pushError = data.error ?? `Server error ${res.status}`;
      } else {
        state.fixed = true;
        state.pendingJobId = null;
      }
    } catch (err: unknown) {
      state.pushError = err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.pushing = false;
    }
  }

  async function discardFix(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    const jobId = state.pendingJobId;
    state.pendingJobId = null;
    state.fixDiff = "";
    state.discarded = true;
    if (jobId) {
      await fetch("/api/dependabot-discard-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    }
  }

  function copySlackMessage(repo: string, pr: PrItem) {
    const message = `:dependabot: *Code review needed* — \`${repo}\`\n> ${pr.title}\n> PR #${pr.number}: ${pr.url}`;
    navigator.clipboard.writeText(message).then(() => {
      const state = stateFor(repo, pr.number);
      state.slackCopied = true;
      setTimeout(() => {
        state.slackCopied = false;
      }, 2500);
    });
  }

  async function recreatePr(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.recreating = true;
    state.recreateError = null;
    try {
      const res = await fetch("/api/dependabot-recreate-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, prNumber }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.recreateError = data.error ?? `Server error ${res.status}`;
      } else {
        state.recreated = true;
      }
    } catch (err: unknown) {
      state.recreateError =
        err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.recreating = false;
    }
  }

  async function deleteBranch(repo: string, prNumber: number) {
    const state = stateFor(repo, prNumber);
    state.deleting = true;
    state.deleteError = null;
    try {
      const res = await fetch("/api/dependabot-delete-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, prNumber }),
      });
      if (!res.ok) {
        const data = await res.json();
        state.deleteError = data.error ?? `Server error ${res.status}`;
      } else {
        state.deleted = true;
      }
    } catch (err: unknown) {
      state.deleteError = err instanceof Error ? err.message : "Unknown error";
    } finally {
      state.deleting = false;
    }
  }

  // ── Bulk branch update ──────────────────────────────────────────────
  const bulkUpdating = ref(false);
  const bulkUpdateSummary = ref<{ succeeded: number; failed: number } | null>(
    null,
  );
  let bulkSummaryTimer: ReturnType<typeof setTimeout> | null = null;

  async function bulkUpdateBranches() {
    if (bulkUpdating.value) return;

    // Close any open dropdown
    document
      .querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((el) => {
        el.removeAttribute("open");
      });

    const outdatedPrs = results.value.flatMap((r) =>
      r.prs
        .filter((p) => p.isBehind)
        .map((p) => ({ repo: r.repo, prNumber: p.number })),
    );
    if (outdatedPrs.length === 0) return;

    bulkUpdating.value = true;
    bulkUpdateSummary.value = null;

    let succeeded = 0;
    let failed = 0;

    await Promise.all(
      outdatedPrs.map(async ({ repo, prNumber }) => {
        try {
          const res = await fetch("/api/dependabot-update-branch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo, prNumber }),
          });
          if (res.ok) {
            succeeded++;
            stateFor(repo, prNumber).updated = true;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }),
    );

    bulkUpdating.value = false;
    bulkUpdateSummary.value = { succeeded, failed };

    if (bulkSummaryTimer) clearTimeout(bulkSummaryTimer);
    bulkSummaryTimer = setTimeout(() => {
      bulkUpdateSummary.value = null;
    }, 6000);
  }

  // ── Branch monitoring ───────────────────────────────────────────────
  const branchMonitoring = ref(false);
  const branchMonitorPrs = ref<Array<{ repo: string; prNumber: number }>>([]);
  const branchMonitorProgress = ref<string | null>(null);
  let branchMonitorInterval: ReturnType<typeof setInterval> | null = null;

  function startBranchMonitoring() {
    // Capture the currently outdated PRs to monitor
    const outdatedPrs = results.value.flatMap((r) =>
      r.prs
        .filter((p) => p.isBehind)
        .map((p) => ({ repo: r.repo, prNumber: p.number })),
    );
    if (outdatedPrs.length === 0) {
      branchMonitoring.value = false;
      return;
    }
    branchMonitorPrs.value = outdatedPrs;
    branchMonitorProgress.value = `Monitoring ${outdatedPrs.length} branch${outdatedPrs.length !== 1 ? "es" : ""}…`;

    // Start polling every 30 seconds
    if (branchMonitorInterval) clearInterval(branchMonitorInterval);
    branchMonitorInterval = setInterval(checkMonitoredBranches, 30_000);
  }

  function stopBranchMonitoring() {
    if (branchMonitorInterval) {
      clearInterval(branchMonitorInterval);
      branchMonitorInterval = null;
    }
    branchMonitorPrs.value = [];
    branchMonitorProgress.value = null;
  }

  async function checkMonitoredBranches() {
    if (branchMonitorPrs.value.length === 0) {
      stopBranchMonitoring();
      branchMonitoring.value = false;
      return;
    }

    try {
      const res = await fetch("/api/dependabot-check-branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prs: branchMonitorPrs.value }),
      });
      if (!res.ok) return;

      const data = (await res.json()) as {
        results: Array<{ repo: string; prNumber: number; isBehind: boolean }>;
      };

      const stillBehind = data.results.filter((r) => r.isBehind);
      const totalMonitored = branchMonitorPrs.value.length;
      const upToDate = totalMonitored - stillBehind.length;

      branchMonitorProgress.value = `${upToDate}/${totalMonitored} up to date`;

      if (stillBehind.length === 0) {
        // All branches are now up to date!
        stopBranchMonitoring();
        branchMonitoring.value = false;
        notifyUser(
          "✅ All branches updated!",
          "All monitored branches are now up to date. You can refresh the page.",
        );
        // Play an alarm sound
        playAlarm();
      }
    } catch {
      // Silently retry on next interval
    }
  }

  function playAlarm() {
    try {
      const ctx = new AudioContext();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      oscillator.start(ctx.currentTime);
      oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
      oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
      oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.45);
      oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.6);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      oscillator.stop(ctx.currentTime + 0.8);
    } catch {
      // Audio not available — notification is enough
    }
  }

  // Watch branchMonitoring toggle
  watch(branchMonitoring, (active) => {
    if (active) {
      startBranchMonitoring();
    } else {
      stopBranchMonitoring();
    }
  });

  function cleanup() {
    if (bulkSummaryTimer) clearTimeout(bulkSummaryTimer);
    stopBranchMonitoring();
    activeEventSources.forEach((source) => source.close());
    activeEventSources.clear();
  }

  return {
    // State
    agentConfig,
    categories,
    results,
    loading,
    fetchError,
    lastFetched,
    expandedCategories,
    expandedRepos,
    selectedPrId,
    actionStates,

    // Computed
    allPrs,
    totalPrCount,
    failingCount,
    passingCount,
    pendingCount,
    outdatedCount,
    readyToMergeCount,
    awaitingReviewCount,
    secondaryReviewCount,
    reposWithPrsCount,
    repoErrorCount,
    treeCategories,
    selectedRepo,
    selectedPrNumber,
    selectedPr,
    selectedState,

    // Tree interactions
    toggleCategory,
    toggleRepo,
    selectPr,

    // API functions
    fetchPrs,
    approvePr,
    mergePr,
    updateBranch,
    stopFix,
    planWithAi,
    replanWithComment,
    executePlan,
    discardPlan,
    fixWithAi,
    pushFix,
    discardFix,
    copySlackMessage,
    recreatePr,
    deleteBranch,

    // Bulk actions
    bulkUpdating,
    bulkUpdateSummary,
    bulkUpdateBranches,

    // Branch monitoring
    branchMonitoring,
    branchMonitorProgress,

    // Helpers
    stateFor,
    activeEventSources,
    cleanup,
  };
}
