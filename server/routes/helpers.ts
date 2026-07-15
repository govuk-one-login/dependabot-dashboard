import { exec, execFile, spawn } from "child_process";
import os from "os";

// In-memory store for assumed role credentials keyed by profile
export const assumedCreds = new Map<
  string,
  {
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SESSION_TOKEN: string;
  }
>();

export const awsEnv = () => ({
  ...process.env,
  AWS_CONFIG_FILE: `${os.homedir()}/.aws/config`,
  AWS_SHARED_CREDENTIALS_FILE: `${os.homedir()}/.aws/credentials`,
  AWS_REGION: "eu-west-2",
});

// Homebrew may not be on PATH when the server process launches — add both common locations
export const BREW_PATH = process.env.PATH?.includes("/opt/homebrew")
  ? process.env.PATH
  : `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

// Kiro CLI installs to ~/.kiro/bin or ~/.local/bin — extend PATH to cover both
export const KIRO_PATH = [
  `${os.homedir()}/.kiro/bin`,
  `${os.homedir()}/.local/bin`,
  BREW_PATH,
].join(":");

export const SANDBOX_NAME = "di-kiro-ai-sandbox";

export function runCommand(
  cmd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { shell: "/bin/sh", env: { ...process.env, PATH: KIRO_PATH } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

// sbx (docker/tap) lives in ~/.docker/bin which Docker Desktop adds to interactive shells
// but not to the Node.js server process — extend PATH to cover it explicitly.
export const SBX_PATH = [
  `${os.homedir()}/.docker/bin`,
  BREW_PATH,
].join(":");

export async function isSandboxRunning(
  sandboxName: string = SANDBOX_NAME,
): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      `sbx ls -q 2>/dev/null | grep -q '^${sandboxName}$'`,
      { shell: "/bin/sh", env: { ...process.env, PATH: SBX_PATH } },
      (error) => {
        resolve(!error);
      },
    );
  });
}

export async function runSandboxCommand(
  cmd: string,
  sandboxName: string = SANDBOX_NAME,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const fullCmd = `sbx exec ${sandboxName} ${cmd}`;
    exec(
      fullCmd,
      { shell: "/bin/sh", env: { ...process.env, PATH: SBX_PATH } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

export { exec, execFile, spawn, os };
