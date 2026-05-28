import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ThrottledOctokit = Octokit.plugin(throttling);

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  if (extra !== undefined) {
    console.log(line, extra);
  } else {
    console.log(line);
  }
}

async function loadConfig() {
  const configPath = resolve(__dirname, "..", "users.json");
  const raw = await readFile(configPath, "utf8");
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.users) || cfg.users.length === 0) {
    throw new Error("users.json: `users` must be a non-empty array");
  }
  return {
    users: cfg.users.map((u) => String(u).trim()).filter(Boolean),
    options: {
      includeForks: cfg.options?.includeForks ?? true,
      includeArchived: cfg.options?.includeArchived ?? false,
      dryRun: cfg.options?.dryRun ?? false,
    },
  };
}

function createClient(token) {
  return new ThrottledOctokit({
    auth: token,
    userAgent: "github-auto-star/1.0.0",
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        log(
          "WARN",
          `Rate limit hit for ${options.method} ${options.url}; retry after ${retryAfter}s (attempt ${retryCount})`,
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        log(
          "WARN",
          `Secondary rate limit for ${options.method} ${options.url}; retry after ${retryAfter}s (attempt ${retryCount})`,
        );
        return retryCount < 2;
      },
    },
  });
}

async function listOwnerRepos(octokit, username) {
  return octokit.paginate(octokit.rest.repos.listForUser, {
    username,
    type: "owner",
    per_page: 100,
  });
}

async function isStarred(octokit, owner, repo) {
  try {
    await octokit.rest.activity.checkRepoIsStarredByAuthenticatedUser({
      owner,
      repo,
    });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

async function starRepo(octokit, owner, repo) {
  await octokit.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
}

async function processUser(octokit, username, options) {
  log("INFO", `Fetching public repos owned by @${username} ...`);
  let repos;
  try {
    repos = await listOwnerRepos(octokit, username);
  } catch (err) {
    log("ERROR", `Failed to list repos for @${username}: ${err.message}`);
    return { user: username, total: 0, starred: 0, skipped: 0, failed: 1 };
  }

  const candidates = repos.filter((r) => {
    if (r.private) return false;
    if (!options.includeForks && r.fork) return false;
    if (!options.includeArchived && r.archived) return false;
    return true;
  });

  log(
    "INFO",
    `@${username}: ${repos.length} owner repos, ${candidates.length} candidates after filtering`,
  );

  let starred = 0;
  let skipped = 0;
  let failed = 0;

  for (const repo of candidates) {
    const fullName = `${repo.owner.login}/${repo.name}`;
    try {
      const already = await isStarred(octokit, repo.owner.login, repo.name);
      if (already) {
        skipped += 1;
        continue;
      }
      if (options.dryRun) {
        log("INFO", `[dry-run] Would star ${fullName}`);
      } else {
        await starRepo(octokit, repo.owner.login, repo.name);
        log("INFO", `Starred ${fullName}`);
      }
      starred += 1;
    } catch (err) {
      failed += 1;
      log("ERROR", `Failed on ${fullName}: ${err.status ?? ""} ${err.message}`);
    }
  }

  return { user: username, total: candidates.length, starred, skipped, failed };
}

async function main() {
  const token = process.env.GITHUB_TOKEN_FOR_STAR || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "Missing token. Set GITHUB_TOKEN_FOR_STAR (preferred) or GH_TOKEN in env.",
    );
  }

  const { users, options } = await loadConfig();
  log(
    "INFO",
    `Loaded ${users.length} target user(s); options=${JSON.stringify(options)}`,
  );

  const octokit = createClient(token);

  const { data: me } = await octokit.rest.users.getAuthenticated();
  log("INFO", `Authenticated as @${me.login}`);

  const results = [];
  for (const u of users) {
    const r = await processUser(octokit, u, options);
    results.push(r);
  }

  log("INFO", "=== Summary ===");
  let totalStarred = 0;
  let totalFailed = 0;
  for (const r of results) {
    log(
      "INFO",
      `@${r.user}: starred=${r.starred} skipped=${r.skipped} failed=${r.failed} (candidates=${r.total})`,
    );
    totalStarred += r.starred;
    totalFailed += r.failed;
  }
  log("INFO", `Total newly starred: ${totalStarred}; total failed: ${totalFailed}`);

  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  log("ERROR", err.stack || err.message);
  process.exit(1);
});
