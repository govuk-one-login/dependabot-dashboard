import { Router, Request, Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "crypto";
import {
  exec,
  spawn,
  BREW_PATH,
  KIRO_PATH,
  isSandboxRunning,
  runSandboxCommand,
  SANDBOX_NAME,
} from "../helpers.js";
import { GITHUB_ORG, isKnownRepo } from "./teams-cache.js";

// ── Pending jobs ────────────────────────────────────────────────────────────

export interface PendingFixJob {
  tmpDir: string;
  repo: string;
  prNumber: string;
  branchName: string;
  diff: string;
  expiresAt: number;
}
export const pendingFixJobs = new Map<string, PendingFixJob>();

// Plan jobs: hold the sandbox state between the plan and execute phases
export interface PendingPlanJob {
  tmpDir: string;
  sandboxDir: string;
  repo: string;
  prNumber: string;
  branchName: string;
  plan: string; // extracted plan text from agent output
  ciLogsDir: string;
  expiresAt: number;
}
export const pendingPlanJobs = new Map<string, PendingPlanJob>();

// Active (in-progress) Kiro child processes — keyed by "repo#prNumber"
export interface ActiveFixJob {
  child: ReturnType<typeof spawn>;
  tmpDir: string;
}
export const activeFixJobs = new Map<string, ActiveFixJob>();

// Expire jobs after 30 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [id, job] of pendingFixJobs) {
      if (job.expiresAt < now) {
        exec(`rm -rf "${job.tmpDir}"`, { shell: "/bin/sh" }, () => {});
        pendingFixJobs.delete(id);
      }
    }
    for (const [id, job] of pendingPlanJobs) {
      if (job.expiresAt < now) {
        exec(`rm -rf "${job.tmpDir}"`, { shell: "/bin/sh" }, () => {});
        pendingPlanJobs.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Make a `step` executor bound to a Response SSE stream for error propagation. */
function makeStep(send: (type: string, data: string) => void) {
  return (
    cmd: string,
    cwd?: string,
    maxBuf = 10 * 1024 * 1024,
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          shell: "/bin/sh",
          cwd,
          env: {
            ...process.env,
            PATH: BREW_PATH,
            ...(process.env.SSH_AUTH_SOCK
              ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
              : {}),
            ...(process.env.SSH_AGENT_PID
              ? { SSH_AGENT_PID: process.env.SSH_AGENT_PID }
              : {}),
            GIT_SSH_COMMAND:
              "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
          },
          maxBuffer: maxBuf,
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).slice(0, 2000)));
          else resolve(stdout.trim());
        },
      );
    });
}

const AGENT_JSON = JSON.stringify(
  {
    name: "dependabot-fixer",
    description:
      "Analyses and fixes CI failures on Dependabot dependency upgrade PRs",
    prompt: "file://~/.kiro/steering/dependabot-fixer.md",
    model: null,
    welcomeMessage:
      "I'll analyse the CI failure and fix the breaking dependency upgrade.",
    tools: ["fs_read", "grep", "glob", "code", "fs_write", "execute_bash"],
    allowedTools: [
      "fs_read",
      "grep",
      "glob",
      "code",
      "fs_write",
      "execute_bash",
    ],
    toolsSettings: {
      execute_bash: {
        allowedCommands: [
          "git *",
          "npm *",
          "npx *",
          "node *",
          "cat *",
          "head *",
          "tail *",
          "find *",
          "grep *",
          "diff *",
          "ls *",
        ],
      },
    },
  },
  null,
  2,
);

// Read-only planner variant — no fs_write so it cannot modify files
const PLANNER_AGENT_JSON = JSON.stringify(
  {
    name: "dependabot-planner",
    description:
      "Analyses CI failures and produces a fix plan — does NOT modify files",
    prompt: "file://~/.kiro/steering/dependabot-planner.md",
    model: null,
    welcomeMessage: "I'll analyse the CI failure and produce a fix plan.",
    tools: ["fs_read", "grep", "glob", "execute_bash"],
    allowedTools: ["fs_read", "grep", "glob", "execute_bash"],
    toolsSettings: {
      execute_bash: {
        allowedCommands: [
          "git *",
          "npm *",
          "npx *",
          "node *",
          "cat *",
          "head *",
          "tail *",
          "find *",
          "grep *",
          "diff *",
          "ls *",
        ],
      },
    },
  },
  null,
  2,
);

const STEERING_MD = [
  "# Dependabot Fixer Agent",
  "",
  "You are a specialist in resolving CI failures caused by Dependabot dependency upgrades.",
  "",
  "## Context",
  "",
  "The target repository (with the Dependabot PR checked out) has been delivered into your working directory. CI failure logs are at `.ci-logs/failure.log`.",
  "",
  "## Step 1 — Read CI Failure Logs (MANDATORY)",
  "",
  "**Before doing ANYTHING else:**",
  "",
  "```bash",
  "cat .ci-logs/failure.log",
  "```",
  "",
  "These logs are your **primary diagnostic source**. Do NOT skip this step or guess from `git diff` alone.",
  "",
  "If the file is empty or absent, fall back to running the build/test commands yourself.",
  "",
  "### What to look for",
  "",
  "- **TypeScript errors:** `error TS` lines with file paths and line numbers",
  "- **Test failures:** `FAIL`, `AssertionError`, expected vs received values",
  "- **Build errors:** `Module not found`, dependency resolution failures",
  "- **Lint errors:** ESLint rule violations with file paths",
  "",
  "## Step 2 — Understand the Upgrade",
  "",
  "```bash",
  "git log --oneline -5",
  "git diff HEAD~1 -- package.json",
  "```",
  "",
  "## Step 3 — Connect Errors to Dependency Changes",
  "",
  "Match CI errors to upgraded packages. Do not skip this reasoning step.",
  "",
  "## Step 4 — Fix the Code",
  "",
  "**Do:** Update call sites, types, test expectations to match new APIs.",
  "**Do NOT:** Downgrade deps, refactor unrelated code, modify `package.json`/`package-lock.json`, add new deps, skip/delete tests.",
  "",
  "## Step 5 — Verify",
  "",
  "```bash",
  "npm run build 2>&1 | tail -30",
  "npm run lint 2>&1 | tail -30",
  "npm test 2>&1 | tail -30",
  "```",
  "",
  "## Output",
  "",
  "End with `## Summary of Changes` listing: dependency upgraded, what broke (cite CI error), what you changed, follow-up actions needed.",
].join("\n");

const PLANNER_STEERING_MD = [
  "# Dependabot Planner Agent",
  "",
  "You are a specialist in analysing CI failures caused by Dependabot dependency upgrades.",
  "",
  "## Your Role",
  "",
  "**You are in PLANNING MODE. You MUST NOT modify any files.** Your only job is to analyse the failure and produce a detailed fix plan. A human will review your plan before any changes are made.",
  "",
  "## Step 1 — Read CI Failure Logs (MANDATORY)",
  "",
  "```bash",
  "cat .ci-logs/failure.log",
  "```",
  "",
  "These logs are your **primary diagnostic source**. Do NOT guess from `git diff` alone.",
  "",
  "## Step 2 — Understand the Upgrade",
  "",
  "```bash",
  "git log --oneline -5",
  "git diff HEAD~1 -- package.json",
  "```",
  "",
  "## Step 3 — Investigate",
  "",
  "Read the relevant source files and `node_modules` type definitions to understand what changed.",
  "",
  "## Output Format",
  "",
  "Produce a plan using EXACTLY this structure:",
  "",
  "## Fix Plan",
  "",
  "### Root Cause",
  "[one paragraph explaining what broke and why]",
  "",
  "### Files to Change",
  "- `path/to/file.ts` — [what to change and why]",
  "- (list every file that needs editing)",
  "",
  "### Steps",
  "1. [specific action]",
  "2. [specific action]",
  "...",
  "",
  "### Verification",
  "Commands to run after making changes to confirm the fix works.",
  "",
  "**Do not modify any files. Output the plan only.**",
].join("\n");

/**
 * Strip ANSI codes and re-join kiro's token-per-line streaming output into
 * readable prose. Lines that start a structural element (heading, list item,
 * blank line, code fence) are preserved as-is; plain-text fragments are
 * appended to the previous line with a space.
 */
function reassembleAgentOutput(lines: string[]): string {
  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  return lines
    .map(stripAnsi)
    .reduce<string[]>((acc, raw) => {
      const line = raw.trimEnd();
      const isStructural =
        line === "" ||
        /^#{1,6}\s/.test(line) ||
        /^[-*+]\s/.test(line) ||
        /^\d+\.\s/.test(line) ||
        line.startsWith("```") ||
        line.startsWith("> ") ||
        line.startsWith("|");

      if (isStructural || acc.length === 0) {
        acc.push(line);
      } else {
        const prev = acc.at(-1)!;
        const prevIsStructural =
          prev === "" ||
          /^#{1,6}\s/.test(prev) ||
          /^[-*+]\s/.test(prev) ||
          /^\d+\.\s/.test(prev) ||
          prev.startsWith("```") ||
          prev.startsWith("> ") ||
          prev.startsWith("|");

        if (prevIsStructural) {
          acc.push(line);
        } else {
          acc[acc.length - 1] = prev + " " + line;
        }
      }
      return acc;
    }, [])
    .join("\n")
    .trim();
}

/** Write agent config files into the repo directory. */
function writeAgentConfig(tmpDir: string, planOnly: boolean) {
  const kiroDir = path.join(tmpDir, ".kiro");
  const agentsDir = path.join(kiroDir, "agents");
  const steeringDir = path.join(kiroDir, "steering");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(steeringDir, { recursive: true });

  if (planOnly) {
    fs.writeFileSync(
      path.join(agentsDir, "dependabot-planner.json"),
      PLANNER_AGENT_JSON,
      "utf8",
    );
    fs.writeFileSync(
      path.join(steeringDir, "dependabot-planner.md"),
      PLANNER_STEERING_MD,
      "utf8",
    );
  } else {
    fs.writeFileSync(
      path.join(agentsDir, "dependabot-fixer.json"),
      AGENT_JSON,
      "utf8",
    );
    fs.writeFileSync(
      path.join(steeringDir, "dependabot-fixer.md"),
      STEERING_MD,
      "utf8",
    );
  }
}

/** Fetch CI failure logs for a branch. Returns empty string on failure. */
async function fetchCiLogs(
  repo: string,
  branchName: string,
  send: (type: string, data: string) => void,
  step: ReturnType<typeof makeStep>,
): Promise<string> {
  try {
    const runId = await step(
      `gh run list --repo ${GITHUB_ORG}/${repo} --branch "${branchName}" --status failure --json databaseId,conclusion --jq '.[0].databaseId'`,
    );
    if (runId && runId !== "null") {
      const raw = await step(
        `gh run view ${runId} --repo ${GITHUB_ORG}/${repo} --log-failed`,
        undefined,
        20 * 1024 * 1024,
      ).catch(() => "");
      send(
        "log",
        `✓ Retrieved CI logs (${raw.length} bytes) from run ${runId}`,
      );
      return raw;
    }
    send("log", "⚠️ No failed CI run found for this PR branch");
  } catch (err) {
    send(
      "log",
      `⚠️ Error fetching CI logs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return "";
}

/** Show the last N non-empty lines from CI logs in the SSE console. */
function streamCiExcerpt(
  logs: string,
  send: (type: string, data: string) => void,
) {
  if (!logs) return;
  const nonEmptyLines = logs.split("\n").filter((l) => l.trim());
  const excerpt = nonEmptyLines.slice(-20).join("\n");
  send("log", "── CI failure excerpt (last 20 lines) ──────────────────");
  excerpt.split("\n").forEach((l) => send("log", l));
  if (nonEmptyLines.length > 20)
    send("log", "… (showing tail only — full log passed to agent)");
  send("log", "────────────────────────────────────────────────────────");
}

/** Clone repo, checkout branch, write CI logs + agent config, copy into sandbox. */
async function prepareRepo(
  repo: string,
  prNumber: string,
  planOnly: boolean,
  extraInstructions: string | undefined,
  send: (type: string, data: string) => void,
  abortedRef: { value: boolean },
): Promise<{
  tmpDir: string;
  sandboxDir: string;
  branchName: string;
  ciLogsDir: string;
  fullFailureLogs: string;
  step: ReturnType<typeof makeStep>;
} | null> {
  const step = makeStep(send);

  const sandboxRunning = await isSandboxRunning();
  if (!sandboxRunning) {
    send("log", `❌ Sandbox "${SANDBOX_NAME}" is not running.`);
    send("done", "error");
    return null;
  }

  const whoamiCheck = await runSandboxCommand("kiro-cli whoami 2>&1");
  if (
    !whoamiCheck.ok ||
    !whoamiCheck.stdout.toLowerCase().includes("logged in")
  ) {
    send("log", "❌ kiro-cli is not authenticated in the sandbox.");
    send("log", `   Run inside the sandbox: kiro-cli login`);
    send("done", "error");
    return null;
  }

  const dirName = `dbot-fix-${repo}-${prNumber}-${Date.now()}`;
  const tmpDir = path.join(os.tmpdir(), dirName);
  const sandboxDir = `/tmp/${dirName}`;

  send("log", `Cloning ${GITHUB_ORG}/${repo}…`);
  await step(
    `rm -rf "${tmpDir}" && git clone --depth=50 git@github.com:${GITHUB_ORG}/${repo}.git "${tmpDir}"`,
  );
  if (abortedRef.value) return null;

  send("log", `Resolving branch for PR #${prNumber}…`);
  const headRef = await step(
    `gh pr view ${prNumber} --repo ${GITHUB_ORG}/${repo} --json headRefName --jq '.headRefName'`,
    tmpDir,
  );
  const branchName = headRef.trim();
  send("log", `Fetching branch ${branchName}…`);
  await step(`git fetch origin "${branchName}":"${branchName}"`, tmpDir);
  await step(`git checkout "${branchName}"`, tmpDir);
  if (abortedRef.value) return null;

  send("log", "Fetching CI failure logs…");
  const fullFailureLogs = await fetchCiLogs(repo, branchName, send, step);
  if (abortedRef.value) return null;

  const ciLogsDir = path.join(tmpDir, ".ci-logs");
  fs.mkdirSync(ciLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(ciLogsDir, "failure.log"),
    fullFailureLogs ||
      "(no CI logs available — could not be fetched from GitHub Actions)",
    "utf8",
  );
  if (extraInstructions) {
    fs.writeFileSync(
      path.join(ciLogsDir, "extra-instructions.txt"),
      extraInstructions,
      "utf8",
    );
  }
  streamCiExcerpt(fullFailureLogs, send);

  writeAgentConfig(tmpDir, planOnly);

  send("log", "Copying repo into sandbox…");
  await step(
    `sbx cp "${tmpDir}" "${SANDBOX_NAME}:/tmp/"`,
    undefined,
    50 * 1024 * 1024,
  );
  if (abortedRef.value) return null;

  await step(
    `sbx exec -u root ${SANDBOX_NAME} chown -R 1000:1000 "${sandboxDir}"`,
  );
  await step(
    `sbx exec ${SANDBOX_NAME} sh -c 'cp -r "${sandboxDir}/.kiro/." "$HOME/.kiro/"'`,
  );

  send("log", "Installing dependencies (may take a minute)…");
  try {
    await step(
      `sbx exec ${SANDBOX_NAME} sh -c 'cd "${sandboxDir}" && npm ci --prefer-offline 2>&1 || npm install 2>&1'`,
      undefined,
      30 * 1024 * 1024,
    );
    send("log", "✓ Dependencies installed successfully.");
  } catch {
    send(
      "log",
      "⚠️ npm install failed (likely private registry auth) — agent will work from CI logs only.",
    );
  }

  return { tmpDir, sandboxDir, branchName, ciLogsDir, fullFailureLogs, step };
}

interface WritePromptOpts {
  ciLogsDir: string;
  sandboxDir: string;
  fullFailureLogs: string;
  repo: string;
  prNumber: string;
  extraInstructions?: string;
  planOnly: boolean;
  planContext?: string;
  step: ReturnType<typeof makeStep>;
}

/** Build and write the initial prompt for kiro, copy it into the sandbox. */
async function writePrompt(opts: WritePromptOpts) {
  const {
    ciLogsDir,
    sandboxDir,
    fullFailureLogs,
    repo,
    prNumber,
    extraInstructions,
    planOnly,
    planContext,
    step,
  } = opts;
  const parts: string[] = [];

  if (planOnly) {
    parts.push(
      `Analyse the CI failure for this Dependabot PR (PR #${prNumber} in ${GITHUB_ORG}/${repo}) and produce a detailed fix plan.`,
      "",
      "DO NOT modify any files. Output the plan only.",
    );
  } else if (planContext) {
    parts.push(
      `Implement the following fix plan for this Dependabot PR (PR #${prNumber} in ${GITHUB_ORG}/${repo}).`,
      "",
      "--- APPROVED FIX PLAN ---",
      planContext,
      "--- END FIX PLAN ---",
      "",
      "Implement each step in the plan. Make only the changes described.",
    );
  } else {
    parts.push(
      `Fix the CI failures for this Dependabot PR (PR #${prNumber} in ${GITHUB_ORG}/${repo}).`,
    );
  }

  if (fullFailureLogs) {
    const truncated =
      fullFailureLogs.length > 30000
        ? `[... truncated — full logs at .ci-logs/failure.log ...]\n${fullFailureLogs.slice(-30000)}`
        : fullFailureLogs;
    parts.push(
      "",
      "--- CI FAILURE LOGS ---",
      truncated,
      "--- END CI FAILURE LOGS ---",
      "",
    );
  }

  if (extraInstructions) {
    parts.push("", "ADDITIONAL INSTRUCTIONS FROM THE USER:", extraInstructions);
  }

  const promptFile = path.join(ciLogsDir, "prompt.txt");
  fs.writeFileSync(promptFile, parts.join("\n"), "utf8");
  await step(
    `sbx cp "${promptFile}" "${SANDBOX_NAME}:${sandboxDir}/.ci-logs/prompt.txt"`,
  );
}

/** Run kiro-cli in the sandbox and collect stdout lines. */
function spawnKiro(
  sandboxDir: string,
  agentName: string,
  req: Request,
  repo: string,
  prNumber: string,
  tmpDir: string,
): { promise: Promise<void>; allStdoutLines: string[]; send?: never } {
  const allStdoutLines: string[] = [];
  return { allStdoutLines, promise: Promise.resolve() }; // placeholder — see usage below
}

// ── Router ──────────────────────────────────────────────────────────────────

const router = Router();

router.get("/dependabot-check-kiro", async (_req: Request, res: Response) => {
  const sandboxRunning = await isSandboxRunning();
  if (!sandboxRunning) {
    res.json({ available: false, detail: "" });
    return;
  }
  const vCheck = await runSandboxCommand("kiro-cli --version 2>&1");
  res.json({
    available: vCheck.ok,
    detail: vCheck.stdout.split("\n")[0] ?? "",
  });
});

// ── Plan phase ──────────────────────────────────────────────────────────────

router.get("/dependabot-plan-pr", async (req: Request, res: Response) => {
  const { repo, prNumber, extraInstructions } = req.query as {
    repo?: string;
    prNumber?: string;
    extraInstructions?: string;
  };
  if (!repo || !prNumber || !/^\d+$/.test(prNumber)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const abortedRef = { value: false };
  req.on("close", () => {
    abortedRef.value = true;
  });

  (async () => {
    let tmpDir = "";
    try {
      const prepared = await prepareRepo(
        repo,
        prNumber,
        true,
        extraInstructions,
        send,
        abortedRef,
      );
      if (!prepared) return;
      const {
        tmpDir: td,
        sandboxDir,
        branchName,
        ciLogsDir,
        fullFailureLogs,
        step,
      } = prepared;
      tmpDir = td;

      await writePrompt({
        ciLogsDir,
        sandboxDir,
        fullFailureLogs,
        repo,
        prNumber,
        extraInstructions,
        planOnly: true,
        planContext: undefined,
        step,
      });

      send(
        "log",
        "Invoking Kiro to analyse the failure and produce a fix plan…",
      );
      send("log", "(this may take a minute or two)");

      const allStdoutLines: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "sbx",
          [
            "exec",
            SANDBOX_NAME,
            "sh",
            "-c",
            `cd "${sandboxDir}" && exec kiro-cli chat --agent dependabot-planner --trust-all-tools --no-interactive "$(cat .ci-logs/prompt.txt)"`,
          ],
          { env: { ...process.env, PATH: BREW_PATH } },
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) =>
          chunk.split("\n").forEach((l) => {
            if (l.trim()) {
              allStdoutLines.push(l);
              send("log", l);
            }
          }),
        );
        child.stderr.on("data", (chunk: string) =>
          chunk
            .split("\n")
            .filter((l) => l.trim())
            .forEach((l) => send("log", l)),
        );
        const jobKey = `${repo}#${prNumber}`;
        activeFixJobs.set(jobKey, { child, tmpDir });
        child.on("close", (code) => {
          activeFixJobs.delete(jobKey);
          code === 0
            ? resolve()
            : reject(new Error(`kiro-cli exited with code ${code}`));
        });
        child.on("error", (err) => {
          activeFixJobs.delete(jobKey);
          reject(new Error(`Failed to start kiro-cli: ${err.message}`));
        });
        req.on("close", () => {
          activeFixJobs.delete(jobKey);
          child.kill();
        });
      });

      if (abortedRef.value) return;

      // Extract and reformat the plan text (kiro streams token-by-token)
      const planStart = allStdoutLines.findLastIndex((l) =>
        /^#{1,3}\s*fix plan/i.test(l.replace(/\x1B\[[0-9;]*m/g, "").trim()),
      );
      const plan = reassembleAgentOutput(
        planStart !== -1
          ? allStdoutLines.slice(planStart)
          : allStdoutLines.slice(-60),
      );

      // Write plan to file for the execute phase to reference
      fs.writeFileSync(path.join(ciLogsDir, "plan.md"), plan, "utf8");

      const planJobId = randomUUID();
      pendingPlanJobs.set(planJobId, {
        tmpDir,
        sandboxDir,
        repo,
        prNumber,
        branchName,
        plan,
        ciLogsDir,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });

      send("plan", plan);
      send("done", `needs-execution:${planJobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      if (tmpDir) exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

// ── Execute plan ────────────────────────────────────────────────────────────

router.get("/dependabot-execute-plan", async (req: Request, res: Response) => {
  const { planJobId, extraInstructions } = req.query as {
    planJobId?: string;
    extraInstructions?: string;
  };
  if (!planJobId) {
    res.status(400).json({ error: "Missing planJobId" });
    return;
  }
  const planJob = pendingPlanJobs.get(planJobId);
  if (!planJob) {
    res.status(404).json({ error: "Plan job not found or expired" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const abortedRef = { value: false };
  req.on("close", () => {
    abortedRef.value = true;
  });

  (async () => {
    const { tmpDir, sandboxDir, repo, prNumber, branchName, plan, ciLogsDir } =
      planJob;
    pendingPlanJobs.delete(planJobId);

    try {
      const step = makeStep(send);

      // Install the fixer agent (replaces planner) into ~/.kiro/ in sandbox
      writeAgentConfig(tmpDir, false);
      await step(
        `sbx cp "${path.join(tmpDir, ".kiro")}" "${SANDBOX_NAME}:/tmp/dbot-kiro-config"`,
      );
      await step(
        `sbx exec -u root ${SANDBOX_NAME} chown -R 1000:1000 /tmp/dbot-kiro-config`,
      );
      await step(
        `sbx exec ${SANDBOX_NAME} sh -c 'cp -r /tmp/dbot-kiro-config/. "$HOME/.kiro/"'`,
      );

      const fullFailureLogs = fs.existsSync(path.join(ciLogsDir, "failure.log"))
        ? fs.readFileSync(path.join(ciLogsDir, "failure.log"), "utf8")
        : "";

      await writePrompt({
        ciLogsDir,
        sandboxDir,
        fullFailureLogs,
        repo,
        prNumber,
        extraInstructions,
        planOnly: false,
        planContext: plan,
        step,
      });

      send("log", "Invoking Kiro to implement the approved plan…");
      send("log", "(this may take several minutes)");

      const allStdoutLines: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "sbx",
          [
            "exec",
            SANDBOX_NAME,
            "sh",
            "-c",
            `cd "${sandboxDir}" && exec kiro-cli chat --agent dependabot-fixer --trust-all-tools --no-interactive "$(cat .ci-logs/prompt.txt)"`,
          ],
          { env: { ...process.env, PATH: BREW_PATH } },
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) =>
          chunk.split("\n").forEach((l) => {
            if (l.trim()) {
              allStdoutLines.push(l);
              send("log", l);
            }
          }),
        );
        child.stderr.on("data", (chunk: string) =>
          chunk
            .split("\n")
            .filter((l) => l.trim())
            .forEach((l) => send("log", l)),
        );
        const jobKey = `${repo}#${prNumber}`;
        activeFixJobs.set(jobKey, { child, tmpDir });
        child.on("close", (code) => {
          activeFixJobs.delete(jobKey);
          code === 0
            ? resolve()
            : reject(new Error(`kiro-cli exited with code ${code}`));
        });
        child.on("error", (err) => {
          activeFixJobs.delete(jobKey);
          reject(new Error(`Failed to start kiro-cli: ${err.message}`));
        });
        req.on("close", () => {
          activeFixJobs.delete(jobKey);
          child.kill();
        });
      });

      if (abortedRef.value) return;

      send("log", "Checking for changes…");
      const status = await step(
        `sbx exec ${SANDBOX_NAME} sh -c 'cd "${sandboxDir}" && git status --short'`,
      );

      if (status.length === 0) {
        send(
          "log",
          "ℹ️  Kiro made no file changes — the failure may need manual review",
        );
        send("done", "no-changes");
        exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
        return;
      }

      const diff = await step(
        `sbx exec ${SANDBOX_NAME} sh -c 'cd "${sandboxDir}" && git add -A && git diff --cached'`,
        undefined,
        10 * 1024 * 1024,
      );
      const patchFile = path.join(ciLogsDir, "fix.patch");
      fs.writeFileSync(patchFile, diff, "utf8");
      await step(`git apply "${patchFile}"`, tmpDir);
      await step("git add -A", tmpDir);

      const jobId = randomUUID();
      pendingFixJobs.set(jobId, {
        tmpDir,
        repo,
        prNumber,
        branchName,
        diff,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      send("diff", diff);

      // Extract and reformat summary (kiro streams token-by-token)
      const summaryIdx = allStdoutLines.findLastIndex((l) =>
        /^#{1,3}\s*(summary|changes|what was changed)/i.test(
          l.replace(/\x1B\[[0-9;]*m/g, "").trim(),
        ),
      );
      const summary = reassembleAgentOutput(
        summaryIdx !== -1
          ? allStdoutLines.slice(summaryIdx)
          : allStdoutLines.slice(-30),
      );

      if (summary) send("summary", summary);
      send("done", `needs-approval:${jobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

// ── Replan ──────────────────────────────────────────────────────────────────

router.get("/dependabot-replan-pr", async (req: Request, res: Response) => {
  const { planJobId, comment } = req.query as {
    planJobId?: string;
    comment?: string;
  };
  if (!planJobId) {
    res.status(400).json({ error: "Missing planJobId" });
    return;
  }
  const planJob = pendingPlanJobs.get(planJobId);
  if (!planJob) {
    res.status(404).json({ error: "Plan job not found or expired" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const abortedRef = { value: false };
  req.on("close", () => {
    abortedRef.value = true;
  });

  (async () => {
    const { tmpDir, sandboxDir, repo, prNumber, branchName, plan, ciLogsDir } =
      planJob;
    pendingPlanJobs.delete(planJobId);

    try {
      const step = makeStep(send);
      const fullFailureLogs = fs.existsSync(path.join(ciLogsDir, "failure.log"))
        ? fs.readFileSync(path.join(ciLogsDir, "failure.log"), "utf8")
        : "";

      // Build replan prompt with previous plan + user comment
      const parts = [
        `Re-analyse the CI failure for PR #${prNumber} in ${GITHUB_ORG}/${repo} and produce a revised fix plan.`,
        "",
        "The previous plan was:",
        "",
        "--- PREVIOUS PLAN ---",
        plan,
        "--- END PREVIOUS PLAN ---",
      ];
      if (comment) {
        parts.push("", "USER FEEDBACK / ADDITIONAL REQUIREMENTS:", comment);
      }
      if (fullFailureLogs) {
        const truncated =
          fullFailureLogs.length > 30000
            ? `[... truncated — full logs at .ci-logs/failure.log ...]\n${fullFailureLogs.slice(-30000)}`
            : fullFailureLogs;
        parts.push(
          "",
          "--- CI FAILURE LOGS ---",
          truncated,
          "--- END CI FAILURE LOGS ---",
        );
      }
      parts.push("", "Produce a revised plan. DO NOT modify any files.");

      const promptFile = path.join(ciLogsDir, "prompt.txt");
      fs.writeFileSync(promptFile, parts.join("\n"), "utf8");
      await step(
        `sbx cp "${promptFile}" "${SANDBOX_NAME}:${sandboxDir}/.ci-logs/prompt.txt"`,
      );

      send("log", "Re-analysing with your feedback…");
      const allStdoutLines: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "sbx",
          [
            "exec",
            SANDBOX_NAME,
            "sh",
            "-c",
            `cd "${sandboxDir}" && exec kiro-cli chat --agent dependabot-planner --trust-all-tools --no-interactive "$(cat .ci-logs/prompt.txt)"`,
          ],
          { env: { ...process.env, PATH: BREW_PATH } },
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) =>
          chunk.split("\n").forEach((l) => {
            if (l.trim()) {
              allStdoutLines.push(l);
              send("log", l);
            }
          }),
        );
        child.stderr.on("data", (chunk: string) =>
          chunk
            .split("\n")
            .filter((l) => l.trim())
            .forEach((l) => send("log", l)),
        );
        const jobKey = `${repo}#${prNumber}`;
        activeFixJobs.set(jobKey, { child, tmpDir });
        child.on("close", (code) => {
          activeFixJobs.delete(jobKey);
          code === 0
            ? resolve()
            : reject(new Error(`kiro-cli exited with code ${code}`));
        });
        child.on("error", (err) => {
          activeFixJobs.delete(jobKey);
          reject(new Error(`Failed to start kiro-cli: ${err.message}`));
        });
        req.on("close", () => {
          activeFixJobs.delete(jobKey);
          child.kill();
        });
      });

      if (abortedRef.value) return;

      const newPlanStart = allStdoutLines.findLastIndex((l) =>
        /^#{1,3}\s*fix plan/i.test(l.replace(/\x1B\[[0-9;]*m/g, "").trim()),
      );
      const newPlan = reassembleAgentOutput(
        newPlanStart !== -1
          ? allStdoutLines.slice(newPlanStart)
          : allStdoutLines.slice(-60),
      );

      fs.writeFileSync(path.join(ciLogsDir, "plan.md"), newPlan, "utf8");

      const newPlanJobId = randomUUID();
      pendingPlanJobs.set(newPlanJobId, {
        tmpDir,
        sandboxDir,
        repo,
        prNumber,
        branchName,
        plan: newPlan,
        ciLogsDir,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });

      send("plan", newPlan);
      send("done", `needs-execution:${newPlanJobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

// ── Discard plan ────────────────────────────────────────────────────────────

router.post("/dependabot-discard-plan", (req: Request, res: Response) => {
  const { planJobId } = req.body as { planJobId?: string };
  if (!planJobId) {
    res.status(400).json({ error: "Missing planJobId" });
    return;
  }
  const job = pendingPlanJobs.get(planJobId);
  if (job) {
    pendingPlanJobs.delete(planJobId);
    exec(`rm -rf "${job.tmpDir}"`, { shell: "/bin/sh" }, () => {});
  }
  res.json({ success: true });
});

// ── Fix PR (direct, no plan phase) ─────────────────────────────────────────

router.get("/dependabot-fix-pr", async (req: Request, res: Response) => {
  const { repo, prNumber, extraInstructions } = req.query as {
    repo?: string;
    prNumber?: string;
    extraInstructions?: string;
  };
  if (!repo || !prNumber || !/^\d+$/.test(prNumber)) {
    res.status(400).json({ error: "Invalid repo or prNumber" });
    return;
  }
  if (!(await isKnownRepo(repo))) {
    res.status(400).json({ error: "Unknown repository" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const abortedRef = { value: false };
  req.on("close", () => {
    abortedRef.value = true;
  });

  (async () => {
    let tmpDir = "";
    try {
      const prepared = await prepareRepo(
        repo,
        prNumber,
        false,
        extraInstructions,
        send,
        abortedRef,
      );
      if (!prepared) return;
      const {
        tmpDir: td,
        sandboxDir,
        branchName,
        ciLogsDir,
        fullFailureLogs,
        step,
      } = prepared;
      tmpDir = td;

      await writePrompt({
        ciLogsDir,
        sandboxDir,
        fullFailureLogs,
        repo,
        prNumber,
        extraInstructions,
        planOnly: false,
        planContext: undefined,
        step,
      });

      send("log", "Invoking Kiro CLI to analyse and fix build failures…");
      send("log", "(this may take several minutes)");

      const allStdoutLines: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "sbx",
          [
            "exec",
            SANDBOX_NAME,
            "sh",
            "-c",
            `cd "${sandboxDir}" && exec kiro-cli chat --agent dependabot-fixer --trust-all-tools --no-interactive "$(cat .ci-logs/prompt.txt)"`,
          ],
          { env: { ...process.env, PATH: BREW_PATH } },
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) =>
          chunk.split("\n").forEach((l) => {
            if (l.trim()) {
              allStdoutLines.push(l);
              send("log", l);
            }
          }),
        );
        child.stderr.on("data", (chunk: string) =>
          chunk
            .split("\n")
            .filter((l) => l.trim())
            .forEach((l) => send("log", l)),
        );
        const jobKey = `${repo}#${prNumber}`;
        activeFixJobs.set(jobKey, { child, tmpDir });
        child.on("close", (code) => {
          activeFixJobs.delete(jobKey);
          code === 0
            ? resolve()
            : reject(new Error(`kiro-cli exited with code ${code}`));
        });
        child.on("error", (err) => {
          activeFixJobs.delete(jobKey);
          reject(new Error(`Failed to start kiro-cli: ${err.message}`));
        });
        req.on("close", () => {
          activeFixJobs.delete(jobKey);
          child.kill();
        });
      });

      if (abortedRef.value) return;

      send("log", "Checking for changes…");
      const status = await step(
        `sbx exec ${SANDBOX_NAME} sh -c 'cd "${sandboxDir}" && git status --short'`,
      );

      if (status.length === 0) {
        send(
          "log",
          "ℹ️  Kiro made no file changes — the failure may need manual review",
        );
        send("done", "no-changes");
        exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
        return;
      }

      const diff = await step(
        `sbx exec ${SANDBOX_NAME} sh -c 'cd "${sandboxDir}" && git add -A && git diff --cached'`,
        undefined,
        10 * 1024 * 1024,
      );
      const patchFile = path.join(ciLogsDir, "fix.patch");
      fs.writeFileSync(patchFile, diff, "utf8");
      await step(`git apply "${patchFile}"`, tmpDir);
      await step("git add -A", tmpDir);

      const jobId = randomUUID();
      pendingFixJobs.set(jobId, {
        tmpDir,
        repo,
        prNumber,
        branchName,
        diff,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      send("diff", diff);

      // Extract and reformat summary (kiro streams token-by-token)
      const summaryIdx = allStdoutLines.findLastIndex((l) =>
        /^#{1,3}\s*(summary|changes|what was changed)/i.test(
          l.replace(/\x1B\[[0-9;]*m/g, "").trim(),
        ),
      );
      const summary = reassembleAgentOutput(
        summaryIdx !== -1
          ? allStdoutLines.slice(summaryIdx)
          : allStdoutLines.slice(-30),
      );

      if (summary) send("summary", summary);
      send("done", `needs-approval:${jobId}`);
      send("done", `needs-approval:${jobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      if (tmpDir) exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

// ── Push / stop / discard ───────────────────────────────────────────────────

router.post("/dependabot-push-fix", async (req: Request, res: Response) => {
  const { jobId } = req.body as { jobId?: string };
  if (!jobId) {
    res.status(400).json({ error: "Missing jobId" });
    return;
  }
  const job = pendingFixJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found or already completed" });
    return;
  }
  pendingFixJobs.delete(jobId);
  try {
    await new Promise<void>((resolve, reject) =>
      exec(
        [
          `git -c commit.gpgsign=true commit -S -m "fix: resolve CI build failures caused by dependency upgrade"`,
          `git push origin HEAD`,
        ].join(" && "),
        {
          shell: "/bin/sh",
          cwd: job.tmpDir,
          env: {
            ...process.env,
            PATH: KIRO_PATH,
            GNUPGHOME: `${process.env.HOME}/.gnupg`,
          },
        },
        (err, _stdout, stderr) =>
          err ? reject(new Error(stderr || err.message)) : resolve(),
      ),
    );
    res.json({ success: true });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    exec(`rm -rf "${job.tmpDir}"`, { shell: "/bin/sh" }, () => {});
  }
});

router.post("/dependabot-stop-fix", (req: Request, res: Response) => {
  const { repo, prNumber } = req.body as { repo?: string; prNumber?: number };
  if (!repo || !prNumber) {
    res.status(400).json({ error: "Missing repo or prNumber" });
    return;
  }
  const jobKey = `${repo}#${prNumber}`;
  const active = activeFixJobs.get(jobKey);
  if (active) {
    active.child.kill("SIGTERM");
    activeFixJobs.delete(jobKey);
    exec(`rm -rf "${active.tmpDir}"`, { shell: "/bin/sh" }, () => {});
  }
  res.json({ success: true });
});

router.post("/dependabot-discard-fix", (req: Request, res: Response) => {
  const { jobId } = req.body as { jobId?: string };
  if (!jobId) {
    res.status(400).json({ error: "Missing jobId" });
    return;
  }
  const job = pendingFixJobs.get(jobId);
  if (job) {
    pendingFixJobs.delete(jobId);
    exec(`rm -rf "${job.tmpDir}"`, { shell: "/bin/sh" }, () => {});
  }
  res.json({ success: true });
});

export default router;
