import { spawn, execSync } from 'node:child_process';

const TIMEOUT_MS = 15 * 60 * 1000;

interface ClaudeJsonEnvelope {
  result: string;
}

/**
 * App secrets (every var this repo's own .env/.env.example defines) that must
 * never reach this subprocess's environment. This tool's entire job is to
 * WebFetch/WebSearch arbitrary third-party URLs (career pages, news
 * articles, etc.) - untrusted content an indirect-prompt-injection attack
 * could target - and the subprocess has no legitimate need for any of these;
 * its own Claude auth is session/keychain-based, not env-var-based. Denylist
 * (rather than an allowlist) deliberately, since enumerating this repo's
 * small known secret set is safer than guessing every OS/runtime var `claude`
 * actually needs to run.
 */
const APP_SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'SESSION_SECRET',
  'GOOGLE_PLACES_API_KEY',
  'BUILTWITH_API_KEY',
  'COMPANIES_HOUSE_API_KEY',
  'TEXAS_COMPTROLLER_API_KEY',
  'PRODUCT_HUNT_API_TOKEN',
  'CRUNCHBASE_API_KEY',
  'GITHUB_TOKEN',
  'HUNTER_API_KEY',
  'PEOPLE_DATA_LABS_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_BRIDGE_URL',
  'CLAUDE_BRIDGE_API_KEY',
  'CRON_SECRET',
  'RESEND_API_KEY',
  'SENDING_DOMAIN',
  'DOMAIN_DNS_VERIFIED',
  'DAILY_SEND_CAP_TEST',
  'DOMAIN_WARMUP_START_DATE',
  'RESEND_WEBHOOK_SECRET',
  'HOURLY_RATE_CENTS',
  'NEON_API_KEY',
  'NEON_PROJECT_ID',
  'CONFIRM_DESTRUCTIVE_TESTS',
] as const;

/**
 * Builds the subprocess env: starts from this process's own env (so the
 * child still has PATH, HOME/USERPROFILE, etc. needed to actually find and
 * run `claude`) and strips every known app secret out of it.
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const subprocessEnv = { ...process.env };
  for (const key of APP_SECRET_ENV_KEYS) {
    delete subprocessEnv[key];
  }
  return subprocessEnv;
}

/**
 * Kills the full process tree rooted at `pid`. On Windows, `shell: true`
 * means the immediate spawned handle may be `cmd.exe` (or, if the globally
 * installed `claude` is an npm `.cmd` shim, a further nested `node.exe`) -
 * a plain `child.kill()` only signals that immediate handle and is not
 * guaranteed to terminate the real underlying `claude` process, which could
 * then run unbounded in the background after the timeout fires. `taskkill
 * /T` recurses through the whole tree. Best-effort: a taskkill failure must
 * not crash the timeout handler.
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`);
    } catch {
      // Best-effort - the timeout is already rejecting the promise either way.
    }
    return;
  }
  process.kill(pid);
}

/**
 * Runs the headless `claude` CLI against `prompt` and returns its raw text
 * result (the agent's JSONL output - see prompt-template.ts's output
 * contract). `--tools WebSearch,WebFetch` restricts the agent to research-only
 * tools (no Bash/Write/Edit) - this tool never wants the agent touching the
 * filesystem or running commands, only reading the web. `--permission-mode
 * bypassPermissions` is paired with that restriction so the two allowed,
 * read-only tools don't hang the run on an interactive permission prompt that
 * has nowhere to go in headless mode.
 *
 * `shell: true` is required on Windows, where a globally-installed `claude`
 * resolves to a `.cmd` shim rather than a directly-spawnable executable.
 */
export function runClaudeAgent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'json', '--tools', 'WebSearch,WebFetch', '--permission-mode', 'bypassPermissions'],
      { shell: true, env: buildSubprocessEnv() }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) {
        killProcessTree(child.pid);
      } else {
        child.kill();
      }
      reject(new Error(`claude CLI timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        const envelope = JSON.parse(stdout) as ClaudeJsonEnvelope;
        resolve(envelope.result);
      } catch (error) {
        reject(new Error(`Failed to parse claude CLI JSON envelope: ${(error as Error).message}\nRaw output: ${stdout}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
