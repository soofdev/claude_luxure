import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import type { UsageInfo } from "../shared/types";

/**
 * Short-lived `codex app-server` sessions used for account management: read who
 * an isolated CODEX_HOME is logged in as, read its quota, drive a device-code
 * login, and log out.
 *
 * Every call pins CODEX_HOME explicitly and strips OPENAI_API_KEY. That is not
 * defensive styling — an ambient key or an inherited home is exactly how the
 * Telegram bridge once aimed a logout at a throwaway profile and revoked the
 * live ChatGPT refresh token server-side, which no file restore could undo.
 */

export interface CodexAccountInfo {
  email?: string;
  planType?: string;
  authMode?: string;
}

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  /** Resolves true when the user finishes the login, false on failure/timeout. */
  completed: Promise<boolean>;
  cancel: () => void;
}

/** One connected app-server, torn down by {@link close}. */
class CodexSession {
  private proc: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private readonly notifyHandlers = new Set<(m: string, p: any) => void>();

  constructor(
    private readonly codexPath: string,
    private readonly codexHome?: string
  ) {}

  async open(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.codexHome) {
      env.CODEX_HOME = this.codexHome;
    }
    delete env.OPENAI_API_KEY;

    const proc = spawn(this.codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.proc = proc;
    proc.on("exit", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("codex app-server exited"));
      }
      this.pending.clear();
      this.proc = null;
    });
    // Drain stderr so a chatty build can't fill the pipe and stall the process.
    proc.stderr?.on("data", () => undefined);

    if (proc.stdout) {
      readline
        .createInterface({ input: proc.stdout, crlfDelay: Infinity })
        .on("line", (line) => this.onLine(line));
    }

    await this.request("initialize", {
      clientInfo: { name: "claude-luxure", title: "Claude Luxure", version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  private onLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line.trim());
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error?.message || "codex request failed"));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      for (const h of this.notifyHandlers) {
        h(msg.method, msg.params || {});
      }
    }
  }

  onNotification(handler: (method: string, params: any) => void): void {
    this.notifyHandlers.add(handler);
  }

  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("codex app-server is not running"));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGTERM");
  }
}

/** Run one request against a fresh app-server and tear it down. */
async function once<T>(
  codexPath: string,
  codexHome: string | undefined,
  fn: (s: CodexSession) => Promise<T>
): Promise<T | null> {
  const session = new CodexSession(codexPath, codexHome);
  try {
    await session.open();
    return await fn(session);
  } catch {
    return null;
  } finally {
    session.close();
  }
}

/** Who is this CODEX_HOME logged in as? `null` when it isn't. */
export async function codexAccountInfo(
  codexPath: string,
  codexHome?: string
): Promise<CodexAccountInfo | null> {
  const res = await once(codexPath, codexHome, (s) =>
    s.request("account/read", { refreshToken: false })
  );
  const account = res?.account;
  if (!account) {
    return null;
  }
  return {
    email: typeof account.email === "string" ? account.email : undefined,
    planType: typeof account.planType === "string" ? account.planType : undefined,
    authMode: typeof account.type === "string" ? account.type : undefined,
  };
}

/**
 * Codex quota mapped onto the chat's two usage bars. Codex windows are
 * self-describing (`windowDurationMins`), so bucket them by duration rather
 * than by position: anything up to a day is the "session" bar, longer is the
 * "weekly" bar. That keeps a 5h window and a 7d window in the slots a Claude
 * user already reads.
 */
export async function codexUsage(
  codexPath: string,
  codexHome?: string
): Promise<UsageInfo | null> {
  const res = await once(codexPath, codexHome, (s) =>
    s.request("account/rateLimits/read", undefined)
  );
  const rl = res?.rateLimits;
  if (!rl) {
    return null;
  }
  const usage: UsageInfo = { fiveHour: null, sevenDay: null };
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.usedPercent !== "number") {
      continue;
    }
    const bucket = {
      utilization: w.usedPercent,
      resetsAt: new Date((Number(w.resetsAt) || 0) * 1000).toISOString(),
    };
    const mins = Number(w.windowDurationMins) || 0;
    if (mins > 0 && mins <= 1440) {
      usage.fiveHour = bucket;
    } else {
      usage.sevenDay = bucket;
    }
  }
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/**
 * Start a ChatGPT device-code login against an isolated CODEX_HOME.
 *
 * Device auth is the right flow here for the same reason it was on Telegram:
 * the browser flow needs a localhost callback, while this returns a URL plus a
 * short code we can render in the panel. The app-server stays alive until the
 * user approves (or cancels), then writes auth.json into that home itself.
 */
export async function startCodexDeviceLogin(
  codexPath: string,
  codexHome: string | undefined,
  timeoutMs = 15 * 60 * 1000
): Promise<CodexDeviceLogin | null> {
  const session = new CodexSession(codexPath, codexHome);
  try {
    await session.open();
  } catch {
    session.close();
    return null;
  }

  let resolveCompleted: (ok: boolean) => void = () => undefined;
  const completed = new Promise<boolean>((resolve) => {
    resolveCompleted = resolve;
  });

  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    session.close();
    resolveCompleted(ok);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);

  session.onNotification((method, params) => {
    if (method === "account/login/completed") {
      finish(params?.success === true);
    }
  });

  let started: any;
  try {
    started = await session.request("account/login/start", {
      type: "chatgptDeviceCode",
    });
  } catch {
    finish(false);
    return null;
  }

  const verificationUrl = started?.verificationUrl;
  const userCode = started?.userCode;
  if (typeof verificationUrl !== "string" || typeof userCode !== "string") {
    finish(false);
    return null;
  }

  return {
    loginId: String(started.loginId ?? ""),
    verificationUrl,
    userCode,
    completed,
    cancel: () => {
      void session
        .request("account/login/cancel", { loginId: started.loginId })
        .catch(() => undefined);
      finish(false);
    },
  };
}

/** Sign an isolated CODEX_HOME out. Returns false if the call failed. */
export async function codexLogout(
  codexPath: string,
  codexHome?: string
): Promise<boolean> {
  const res = await once(codexPath, codexHome, async (s) => {
    await s.request("account/logout", undefined);
    return true;
  });
  return res === true;
}

/** Models the signed-in account can actually use, newest-first as Codex ranks them. */
export async function codexModels(
  codexPath: string,
  codexHome?: string
): Promise<{ id: string; label: string }[]> {
  const res = await once(codexPath, codexHome, (s) =>
    s.request("model/list", { limit: 32 })
  );
  const data: any[] = res?.data || [];
  return data
    .filter((m) => m && !m.hidden && typeof m.id === "string")
    .map((m) => ({ id: String(m.id), label: String(m.displayName || m.id) }));
}
