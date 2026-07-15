import { Router, Request, Response } from "express";
import fs from "fs";
import { exec, spawn, runCommand, BREW_PATH, SBX_PATH, KIRO_PATH, isSandboxRunning, runSandboxCommand, SANDBOX_NAME } from "../helpers.js";

const router = Router();

// ── Pre-flight checks ───────────────────────────────────────────────────────

router.get("/dependabot-preflight", async (req: Request, res: Response) => {
  const { agent = "kiro", model = "" } = req.query as {
    agent?: string;
    model?: string;
  };

  const ghCheck = await runCommand("which gh");
  const ghInstalled = ghCheck.ok && ghCheck.stdout.length > 0;

  const brewCheck = await runCommand("which brew");
  const brewInstalled = brewCheck.ok && brewCheck.stdout.length > 0;

  let ghVersion = "";
  let ghAuthenticated = false;
  let ghAuthUser = "";

  if (ghInstalled) {
    const versionResult = await runCommand("gh --version");
    ghVersion = versionResult.stdout.split("\n")[0] ?? "";
    const authResult = await runCommand("gh auth status 2>&1");
    ghAuthenticated = authResult.ok;
    const match = /Logged in to \S+ account (\S+)/i.exec(
      authResult.stdout + authResult.stderr,
    );
    if (match) ghAuthUser = match[1];
  }

  // ── Kiro checks (only when agent=kiro) ───────────────────────────
  let sbxInstalled = false;
  let sbxExecRaw = "";
  let sbxExecFound = false;
  let sbxFsHits: string[] = [];
  let kiroInstalled = false;
  let kiroVersion = "";
  let kiroAuthenticated = false;
  let kiroAuthUser = "";
  let aiSandboxFound = false;
  let aiSandboxPath = "";
  if (agent === "kiro") {
    // Exec check: embed exit code in stdout to avoid error.code type ambiguity
    sbxExecRaw = await new Promise<string>((resolve) => {
      exec(
        "sbx ls 2>/dev/null; echo __sbx_exit_$?",
        { shell: "/bin/sh", env: { ...process.env, PATH: SBX_PATH } },
        (_error, stdout) => resolve(stdout.trim()),
      );
    });
    sbxExecFound = !sbxExecRaw.includes("__sbx_exit_127");

    // Filesystem check: direct binary lookup bypasses PATH entirely
    const sbxFsPaths = [
      `${process.env.HOME}/.docker/bin/sbx`,
      "/opt/homebrew/bin/sbx",
      "/usr/local/bin/sbx",
    ];
    sbxFsHits = sbxFsPaths.filter((p) => fs.existsSync(p));

    sbxInstalled = sbxExecFound || sbxFsHits.length > 0;

    const sandboxRunning = sbxInstalled && (await isSandboxRunning());
    if (sandboxRunning) {
      const vResult = await runSandboxCommand("kiro-cli --version 2>&1");
      if (vResult.ok && vResult.stdout.length > 0) {
        kiroInstalled = true;
        kiroVersion = vResult.stdout.split("\n")[0] ?? "";
        const whoami = await runSandboxCommand("kiro-cli whoami 2>&1");
        if (whoami.ok && whoami.stdout.toLowerCase().includes("logged in")) {
          kiroAuthenticated = true;
          const profileMatch = whoami.stdout.match(/^([^\n]+)$/m);
          kiroAuthUser = profileMatch ? profileMatch[1].trim() : "";
        }
      }
    }

    // Check whether the ai-sandbox repo has been cloned (non-blocking)
    const aiSandboxSearch = await runCommand(
      `find "${process.env.HOME}" -maxdepth 4 -name "ai-sandbox" -type d -prune 2>/dev/null | head -1`,
    );
    if (aiSandboxSearch.stdout.length > 0) {
      const candidatePath = aiSandboxSearch.stdout.trim();
      const remoteCheck = await runCommand(
        `git -C "${candidatePath}" remote get-url origin 2>/dev/null`,
      );
      aiSandboxFound = remoteCheck.stdout.includes("ai-sandbox");
      if (aiSandboxFound) aiSandboxPath = candidatePath;
    }
  }

  // ── Ollama checks (only when agent=ollama) ───────────────────────
  let ollamaInstalled = false;
  let ollamaVersion = "";
  let ollamaRunning = false;
  let ollamaModelPulled = false;
  if (agent === "ollama") {
    const ollamaCheck = await runCommand("which ollama");
    ollamaInstalled = ollamaCheck.ok && ollamaCheck.stdout.length > 0;
    if (ollamaInstalled) {
      const vResult = await runCommand("ollama --version 2>&1");
      ollamaVersion = vResult.stdout.split("\n")[0] ?? "";
    }
    // Check if Ollama daemon is running by hitting its local REST API
    try {
      const http = await import("node:http");
      await new Promise<void>((resolve, reject) => {
        const req2 = http.get("http://localhost:11434/api/tags", (r) => {
          let body = "";
          r.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          r.on("end", () => {
            ollamaRunning = true;
            if (model) {
              try {
                const parsed = JSON.parse(body) as {
                  models?: { name: string }[];
                };
                const models = parsed.models ?? [];
                ollamaModelPulled = models.some(
                  (m) =>
                    m.name === model ||
                    m.name.startsWith(`${model}:`) ||
                    m.name.split(":")[0] === model,
                );
              } catch {
                ollamaModelPulled = false;
              }
            }
            resolve();
          });
        });
        req2.on("error", reject);
        req2.setTimeout(3000, () => {
          req2.destroy();
          reject(new Error("timeout"));
        });
      });
    } catch {
      ollamaRunning = false;
      ollamaModelPulled = false;
    }
  }

  const gpgSignResult = await runCommand("git config --global commit.gpgsign");
  const gpgProgramResult = await runCommand("git config --global gpg.program");
  const signingKeyResult = await runCommand(
    "git config --global user.signingkey",
  );
  const gpgSignEnabled = gpgSignResult.stdout.trim() === "true";
  const gpgProgram = gpgProgramResult.stdout.trim();
  const signingKey = signingKeyResult.stdout.trim();
  let gpgKeyValid = false;
  if (signingKey) {
    const keyCheck = await runCommand(
      `gpg --list-secret-keys "${signingKey}" 2>/dev/null`,
    );
    gpgKeyValid = keyCheck.ok && keyCheck.stdout.length > 0;
  }

  const agentConfPath = `${process.env.HOME}/.gnupg/gpg-agent.conf`;
  let pinentryOk = false;
  try {
    const agentConf = fs.readFileSync(agentConfPath, "utf-8");
    pinentryOk = /pinentry-program[^\n]*pinentry-mac/.test(agentConf);
  } catch {
    pinentryOk = false;
  }

  res.json({
    gh: {
      installed: ghInstalled,
      version: ghVersion,
      authenticated: ghAuthenticated,
      authUser: ghAuthUser,
    },
    brew: { installed: brewInstalled },
    sbx: {
      installed: sbxInstalled,
      _debug: {
        execRaw: sbxExecRaw,
        execFound: sbxExecFound,
        fsHits: sbxFsHits,
        home: process.env.HOME,
        sbxPath: SBX_PATH,
      },
    },
    kiro: {
      installed: kiroInstalled,
      version: kiroVersion,
      authenticated: kiroAuthenticated,
      authUser: kiroAuthUser,
      aiSandboxFound,
      aiSandboxPath,
    },
    ollama: {
      installed: ollamaInstalled,
      version: ollamaVersion,
      running: ollamaRunning,
      modelPulled: ollamaModelPulled,
      model,
    },
    gpgSigning: {
      enabled: gpgSignEnabled,
      program: gpgProgram,
      signingKey,
      keyValid: gpgKeyValid,
      pinentryOk,
    },
  });
});

router.post(
  "/dependabot-enable-signing",
  async (_req: Request, res: Response) => {
    const gpg2Check = await runCommand("which gpg2");
    const gpgCheck = await runCommand("which gpg");
    let gpgProgram = "gpg";
    if (gpg2Check.ok && gpg2Check.stdout) {
      gpgProgram = gpg2Check.stdout.trim();
    } else if (gpgCheck.ok && gpgCheck.stdout) {
      gpgProgram = gpgCheck.stdout.trim();
    }

    const keyListResult = await runCommand(
      "gpg --list-secret-keys --keyid-format=long 2>/dev/null",
    );
    const keyMatch = /^sec[^/]*\/([0-9A-F]{16,})/im.exec(keyListResult.stdout);
    const signingKey = keyMatch ? keyMatch[1] : "";

    if (!signingKey) {
      res.status(400).json({
        success: false,
        message:
          "No GPG secret key found in keyring. Generate one with: gpg --gen-key",
      });
      return;
    }

    const commands = [
      `git config --global commit.gpgsign true`,
      `git config --global gpg.program "${gpgProgram}"`,
      `git config --global user.signingkey "${signingKey}"`,
    ];
    for (const cmd of commands) {
      const result = await runCommand(cmd);
      if (!result.ok) {
        res.status(500).json({
          success: false,
          message: `Failed to set config: ${cmd}\n${result.stderr}`,
        });
        return;
      }
    }

    const pinentryMacPaths = [
      "/opt/homebrew/bin/pinentry-mac",
      "/usr/local/bin/pinentry-mac",
    ];
    let pinentryMacPath = pinentryMacPaths.find((p) => fs.existsSync(p)) ?? "";
    if (!pinentryMacPath) {
      const installResult = await runCommand("brew install pinentry-mac");
      if (!installResult.ok) {
        res.status(500).json({
          success: false,
          message: `GPG git config set, but failed to install pinentry-mac: ${installResult.stderr}. Run: brew install pinentry-mac`,
        });
        return;
      }
      pinentryMacPath =
        pinentryMacPaths.find((p) => fs.existsSync(p)) ??
        "/opt/homebrew/bin/pinentry-mac";
    }

    const gnupgDir = `${process.env.HOME}/.gnupg`;
    const agentConfPath = `${gnupgDir}/gpg-agent.conf`;
    let existing = "";
    try {
      existing = fs.readFileSync(agentConfPath, "utf-8");
    } catch {}
    const cleaned = existing
      .split("\n")
      .filter((l) => !l.startsWith("pinentry-program"))
      .join("\n")
      .trimEnd();
    const newConf = `${cleaned ? cleaned + "\n" : ""}pinentry-program ${pinentryMacPath}\n`;
    fs.mkdirSync(gnupgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(agentConfPath, newConf, { mode: 0o600 });

    await runCommand("gpgconf --kill gpg-agent");

    res.json({ success: true, gpgProgram, signingKey, pinentryMacPath });
  },
);

router.get("/dependabot-install-gh", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  send("log", "$ brew install gh");

  const child = spawn("brew", ["install", "gh"], {
    shell: "/bin/sh",
    env: { ...process.env, PATH: BREW_PATH },
  });

  child.stdout.on("data", (chunk: Buffer) => send("log", chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => send("log", chunk.toString()));
  child.on("close", (code: number | null) => {
    send("done", code === 0 ? "success" : "error");
    res.end();
  });

  req.on("close", () => child.kill());
});

router.get("/dependabot-install-kiro", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type: string, data: string) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  send("log", "$ curl -fsSL https://cli.kiro.dev/install | bash");
  send("log", "(running official Kiro installer — this may take a minute)");

  const child = spawn(
    "bash",
    ["-c", "curl -fsSL https://cli.kiro.dev/install | bash"],
    { env: { ...process.env, PATH: KIRO_PATH } },
  );

  child.stdout.on("data", (chunk: Buffer) => send("log", chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => send("log", chunk.toString()));
  child.on("close", (code: number | null) => {
    if (code === 0) {
      send("log", "✅ kiro-cli installed successfully.");
      send("log", "ℹ️  Restart the server so the updated PATH is picked up.");
    }
    send("done", code === 0 ? "success" : "error");
    res.end();
  });

  req.on("close", () => child.kill());
});

router.post("/dependabot-gh-auth-login", (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    res.status(400).json({ success: false, message: "token is required" });
    return;
  }

  const child = spawn("gh", ["auth", "login", "--with-token"], {
    shell: "/bin/sh",
    env: { ...process.env, PATH: BREW_PATH },
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("close", (code: number | null) => {
    if (code === 0) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        success: false,
        message: stderr.trim() || "gh auth login failed",
      });
    }
  });

  child.stdin.write(`${token.trim()}\n`);
  child.stdin.end();
});

router.post("/dependabot-gh-auth-logout", (_req: Request, res: Response) => {
  exec(
    "gh auth logout --hostname github.com",
    { shell: "/bin/sh", env: { ...process.env, PATH: BREW_PATH } },
    (error) => {
      if (error && !error.message.includes("not logged")) {
        res.status(500).json({ success: false, message: error.message });
        return;
      }
      res.json({ success: true });
    },
  );
});

export default router;
