import { Router, Request, Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import {
  exec,
  spawn,
  os,
  runCommand,
  BREW_PATH,
  KIRO_PATH,
  isSandboxRunning,
  runSandboxCommand,
  SANDBOX_NAME,
} from "../helpers.js";
import { GITHUB_ORG, isKnownRepo } from "./teams-cache.js";

// Pending AI fix jobs awaiting user approval before push
export interface PendingFixJob {
  tmpDir: string;
  repo: string;
  prNumber: string;
  branchName: string;
  diff: string;
  expiresAt: number;
}
export const pendingFixJobs = new Map<string, PendingFixJob>();

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
  },
  5 * 60 * 1000,
);

const router = Router();

router.get("/dependabot-check-kiro", async (_req: Request, res: Response) => {
  const sandboxRunning = await isSandboxRunning();
  if (!sandboxRunning) {
    res.json({ available: false, detail: "" });
    return;
  }
  const vCheck = await runSandboxCommand("kiro-cli --version 2>&1");
  res.json({ available: vCheck.ok, detail: vCheck.stdout.split("\n")[0] ?? "" });
});

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

  const tmpDir = path.join(
    os.tmpdir(),
    `dbot-fix-${repo}-${prNumber}-${Date.now()}`,
  );

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  const step = (
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

  (async () => {
    try {
      const sandboxRunning = await isSandboxRunning();
      if (!sandboxRunning) {
        send("log", `❌ Sandbox "${SANDBOX_NAME}" is not running.`);
        send("done", "error");
        return;
      }

      const whoamiCheck = await runSandboxCommand("kiro-cli whoami 2>&1");
      if (
        !whoamiCheck.ok ||
        !whoamiCheck.stdout.toLowerCase().includes("logged in")
      ) {
        send("log", "❌ kiro-cli is not authenticated in the sandbox.");
        send("log", `   Run inside the sandbox: kiro-cli login`);
        send("done", "error");
        return;
      }

      send("log", `Cloning ${GITHUB_ORG}/${repo}…`);
      await step(
        `rm -rf "${tmpDir}" && git clone --depth=50 git@github.com:${GITHUB_ORG}/${repo}.git "${tmpDir}"`,
      );
      if (aborted) return;

      send("log", `Resolving branch for PR #${prNumber}…`);
      const headRef = await step(
        `gh pr view ${prNumber} --repo ${GITHUB_ORG}/${repo} --json headRefName --jq '.headRefName'`,
        tmpDir,
      );
      const branchName = headRef.trim();
      send("log", `Fetching branch ${branchName}…`);
      await step(`git fetch origin "${branchName}":"${branchName}"`, tmpDir);
      await step(`git checkout "${branchName}"`, tmpDir);
      if (aborted) return;

      send("log", "Fetching CI failure logs…");
      let failureLogs =
        "(no failed CI run found — proceeding on diff context only)";
      try {
        const runId = await step(
          `gh run list --pr ${prNumber} --repo ${GITHUB_ORG}/${repo} --json databaseId,conclusion --jq '[.[] | select(.conclusion=="failure")] | .[0].databaseId'`,
        );
        if (runId && runId !== "null") {
          const raw = await step(
            `gh run view ${runId} --repo ${GITHUB_ORG}/${repo} --log-failed`,
            undefined,
            20 * 1024 * 1024,
          ).catch(() => "");
          failureLogs =
            raw.length > 10000
              ? raw.slice(0, 10000) + "\n[... truncated ...]"
              : raw;
        }
      } catch {
        failureLogs =
          "(error fetching CI logs — proceeding on diff context only)";
      }
      if (aborted) return;

      send("log", "Installing dependencies (may take a minute)…");
      let npmInstalled = false;
      try {
        await step(
          "npm ci --prefer-offline 2>&1 || npm install 2>&1",
          tmpDir,
          30 * 1024 * 1024,
        );
        npmInstalled = true;
        send("log", "✓ Dependencies installed successfully.");
      } catch {
        send(
          "log",
          "⚠️ npm install failed (likely private registry auth) — agent will work from CI logs only.",
        );
      }
      if (aborted) return;

      const depsNote = npmInstalled
        ? `node_modules is available. After making your changes, run the linter and unit tests (e.g. \`npx eslint . --ext .ts\` and \`npx jest\` or whatever test/lint scripts are in package.json) to confirm everything passes before finishing.`
        : `node_modules is NOT available (private registry auth failed). Do NOT attempt to run npm install, npm test, or eslint. Rely entirely on the CI logs and reading source files to determine fixes.`;

      const userPrompt = [
        `Fix the CI build failures in this repository caused by a Dependabot dependency upgrade (PR #${prNumber} in ${GITHUB_ORG}/${repo}).`,
        `The branch is already checked out in your working directory. ${depsNote}`,
        ``,
        `CI FAILURE LOGS:`,
        `\`\`\``,
        failureLogs,
        `\`\`\``,
        ...(extraInstructions
          ? [``, `ADDITIONAL INSTRUCTIONS FROM THE USER:`, extraInstructions]
          : []),
      ].join("\n");

      send("log", "Invoking Kiro CLI to analyse and fix build failures…");
      send("log", "(this may take several minutes)");

      const allStdoutLines: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "sbx",
          [
            "exec",
            SANDBOX_NAME,
            "kiro-cli",
            "chat",
            "--no-interactive",
            "--trust-all-tools",
            "--agent",
            "dependabot-fixer",
            userPrompt,
          ],
          { cwd: tmpDir, env: { ...process.env, PATH: BREW_PATH } },
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
          return code === 0
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

      if (aborted) return;

      send("log", "Checking for changes…");
      const status = await step("git status --short", tmpDir);

      if (status.length === 0) {
        send(
          "log",
          "ℹ️  Kiro made no file changes — the failure may need manual review",
        );
        send("done", "no-changes");
        exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
        return;
      }

      await step("git add -A", tmpDir);
      const diff = await step("git diff --cached", tmpDir);

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

      // Extract summary from the agent's output.
      // The agent is prompted to end with "## Summary of Changes" followed by its explanation.
      // Fallback: take the last block of text output (after the last tool-like line).
      let summaryHeadingIdx = -1;
      for (let i = allStdoutLines.length - 1; i >= 0; i--) {
        if (
          /^#{1,3}\s*(summary|changes|what was changed)/i.test(
            allStdoutLines[i].trim(),
          )
        ) {
          summaryHeadingIdx = i;
          break;
        }
      }
      let summaryRaw = "";
      if (summaryHeadingIdx !== -1) {
        summaryRaw = allStdoutLines.slice(summaryHeadingIdx).join("\n");
      } else {
        // Fallback: take the last contiguous non-empty block (up to 30 lines)
        const tail = allStdoutLines.slice(-30);
        summaryRaw = tail.join("\n");
      }

      // Clean summary: strip ANSI escape codes, then re-join token-per-line
      // fragments into coherent paragraphs.
      const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
      const cleaned = stripAnsi(summaryRaw);
      // Re-join fragmented lines: lines that don't start a new structural element
      // (heading, list item, blank line) are joined to the previous line with a space.
      const summary = cleaned
        .split("\n")
        .reduce<string[]>((acc, line) => {
          const trimmed = line.trimEnd();
          // Preserve blank lines, headings, and list items as paragraph breaks
          if (
            trimmed === "" ||
            /^#{1,3}\s/.test(trimmed) ||
            /^[-*]\s/.test(trimmed) ||
            /^\d+\.\s/.test(trimmed)
          ) {
            acc.push(trimmed);
          } else if (acc.length === 0) {
            acc.push(trimmed);
          } else {
            const prev = acc[acc.length - 1];
            // If previous line is blank/heading/list-start, start new paragraph
            if (
              prev === "" ||
              /^#{1,3}\s/.test(prev) ||
              /^[-*]\s/.test(prev) ||
              /^\d+\.\s/.test(prev)
            ) {
              acc.push(trimmed);
            } else {
              // Append to previous line (rejoin fragments)
              acc[acc.length - 1] = prev + " " + trimmed;
            }
          }
          return acc;
        }, [])
        .join("\n")
        .trim();

      if (summary) {
        send("summary", summary);
      }

      send("done", `needs-approval:${jobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

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
