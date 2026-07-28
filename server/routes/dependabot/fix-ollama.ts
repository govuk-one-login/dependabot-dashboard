import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { exec, os, BREW_PATH } from "../helpers.js";
import { GITHUB_ORG, isKnownRepo } from "./teams-cache.js";
import { pendingFixJobs } from "./fix-kiro.js";

const router = Router();

// ── Fix a failing Dependabot PR with Ollama ──────────────────────────────────

router.get("/dependabot-fix-pr-ollama", async (req: Request, res: Response) => {
  const {
    repo,
    prNumber,
    model = "codellama",
    extraInstructions,
  } = req.query as {
    repo?: string;
    prNumber?: string;
    model?: string;
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
    `dbot-ollama-${repo}-${prNumber}-${Date.now()}`,
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
      // Verify Ollama is reachable
      send("log", `Checking Ollama is running (model: ${model})…`);
      const http = await import("node:http");
      await new Promise<void>((resolve, reject) => {
        const check = http.get("http://localhost:11434/api/tags", (r) => {
          r.resume();
          r.on("end", resolve);
        });
        check.on("error", reject);
        check.setTimeout(3000, () => {
          check.destroy();
          reject(new Error("Ollama not reachable at http://localhost:11434"));
        });
      });

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

      send("log", "Collecting PR diff…");
      const prDiff = await step(
        `git diff origin/main...HEAD -- . ':(exclude)package-lock.json' ':(exclude)yarn.lock' 2>/dev/null || git diff HEAD~1 HEAD -- . ':(exclude)package-lock.json' ':(exclude)yarn.lock'`,
        tmpDir,
      ).catch(() => "(could not get PR diff)");

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
            raw.length > 12000
              ? raw.slice(0, 12000) + "\n[... truncated ...]"
              : raw;
        }
      } catch {
        failureLogs =
          "(error fetching CI logs — proceeding on diff context only)";
      }
      if (aborted) return;

      // Collect a snapshot of source files (package.json + files touched by the diff)
      send("log", "Collecting source context…");
      let pkgJson = "";
      try {
        pkgJson = fs.readFileSync(`${tmpDir}/package.json`, "utf-8");
        if (pkgJson.length > 4000) pkgJson = pkgJson.slice(0, 4000) + "\n…";
      } catch {
        pkgJson = "(not found)";
      }

      // Build prompt
      const systemPrompt = `You are an expert software engineer. Your task is to fix build/test failures in a repository caused by a Dependabot dependency upgrade. You will be given:
1. The dependency changes (PR diff)
2. CI failure logs
3. The package.json

Analyse the failures and provide fixes. Output ONLY the complete content of files you need to change, using this exact format for each file:

<<<< FILE: relative/path/to/file >>>>
<full file content here>
<<<< END >>>>

After all file blocks, write a "## Summary of Changes" section explaining what you fixed and why.
Do NOT include unchanged files. Do NOT use markdown code fences. Use only the <<<< FILE: ... >>>> format above.`;

      const userMessage = [
        `Fix the CI build failures in ${GITHUB_ORG}/${repo} caused by Dependabot PR #${prNumber}.`,
        ``,
        `## Dependabot PR Diff (dependency changes):`,
        prDiff.length > 8000
          ? prDiff.slice(0, 8000) + "\n[... truncated ...]"
          : prDiff,
        ``,
        `## package.json:`,
        pkgJson,
        ``,
        `## CI Failure Logs:`,
        failureLogs,
        ...(extraInstructions
          ? [``, `## Additional Instructions:`, extraInstructions]
          : []),
      ].join("\n");

      send(
        "log",
        `Sending context to Ollama (model: ${model}) — this may take several minutes…`,
      );

      // Call Ollama chat API (streaming)
      const ollamaPayload = JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        stream: true,
      });

      const fullResponse = await new Promise<string>((resolve, reject) => {
        const ollamaReq = http.request(
          {
            hostname: "localhost",
            port: 11434,
            path: "/api/chat",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(ollamaPayload),
            },
          },
          (r) => {
            let accumulated = "";
            let fullText = "";
            r.setEncoding("utf8");
            r.on("data", (chunk: string) => {
              accumulated += chunk;
              const lines = accumulated.split("\n");
              accumulated = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line) as {
                    message?: { content?: string };
                    done?: boolean;
                    error?: string;
                  };
                  if (parsed.error) {
                    reject(new Error(`Ollama error: ${parsed.error}`));
                    return;
                  }
                  const token = parsed.message?.content ?? "";
                  fullText += token;
                  // Stream tokens to the UI
                  if (token.includes("\n")) {
                    token
                      .split("\n")
                      .filter((l) => l.trim())
                      .forEach((l) => send("log", l));
                  }
                } catch {
                  // partial JSON — ignore
                }
              }
            });
            r.on("end", () => resolve(fullText));
            r.on("error", reject);
          },
        );
        ollamaReq.on("error", reject);
        ollamaReq.setTimeout(300_000, () => {
          ollamaReq.destroy();
          reject(new Error("Ollama request timed out after 5 minutes"));
        });
        ollamaReq.write(ollamaPayload);
        ollamaReq.end();
      });

      if (aborted) return;

      send("log", "Parsing Ollama response for file changes…");

      // Extract file blocks: <<<< FILE: path >>>> ... <<<< END >>>>
      const fileBlockRegex =
        /<<<< FILE: ([^\n>]+) >>>>\n([\s\S]*?)<<<< END >>>>/g;
      const fileChanges: { filePath: string; content: string }[] = [];
      let match: RegExpExecArray | null;
      while ((match = fileBlockRegex.exec(fullResponse)) !== null) {
        const filePath = match[1].trim();
        const content = match[2];
        // Basic path safety: reject absolute paths or path traversal
        if (filePath.startsWith("/") || filePath.includes("..")) {
          send("log", `⚠️  Skipping unsafe path: ${filePath}`);
          continue;
        }
        fileChanges.push({ filePath, content });
      }

      if (fileChanges.length === 0) {
        send(
          "log",
          "ℹ️  Ollama provided no parseable file changes — the failure may need manual review",
        );
        send("done", "no-changes");
        exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
        return;
      }

      send("log", `Applying ${fileChanges.length} file change(s)…`);
      for (const { filePath, content } of fileChanges) {
        const absPath = path.join(tmpDir, filePath);
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, "utf-8");
        send("log", `  ✓ ${filePath}`);
      }

      await step('git add -A -- . ":!.ci-logs" ":!.kiro"', tmpDir);
      const diff = await step('git diff --cached -- . ":!.ci-logs" ":!.kiro"', tmpDir);

      if (!diff.trim()) {
        send(
          "log",
          "ℹ️  No effective changes after applying — the failure may need manual review",
        );
        send("done", "no-changes");
        exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
        return;
      }

      // Extract summary from the response
      let summaryRaw = "";
      const summaryMatch = /^#{1,3}\s*summary of changes[\s\S]*/im.exec(
        fullResponse,
      );
      if (summaryMatch) {
        summaryRaw = summaryMatch[0].slice(0, 3000);
      }
      if (summaryRaw) {
        send("summary", summaryRaw.trim());
      }

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
      send("done", `needs-approval:${jobId}`);
    } catch (err) {
      send("log", `❌ ${err instanceof Error ? err.message : String(err)}`);
      send("done", "error");
      exec(`rm -rf "${tmpDir}"`, { shell: "/bin/sh" }, () => {});
    }
  })();
});

export default router;
