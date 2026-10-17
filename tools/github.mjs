// Tool: summarize a GitHub pull request, repository or commit from its URL (REST API, GITHUB_TOKEN optional).
import { readCapped, decodeBytes, clip } from './util.mjs';

const API = process.env.GITHUB_API || 'https://api.github.com';
const SEG = /^[A-Za-z0-9_.-]+$/;

/** https://github.com/o/r[/pull/N | /commit/SHA | anything else] -> { kind, owner, repo, ... } or null. */
export function parseGithubUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['github.com', 'www.github.com'].includes(u.hostname)) return null;
  const [owner, repoRaw, type, id] = u.pathname.split('/').filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, '');
  if (!owner || !repo || !SEG.test(owner) || !SEG.test(repo)) return null;
  if (type === 'pull' && /^\d+$/.test(id || '')) return { kind: 'pull_request', owner, repo, number: Number(id) };
  if (type === 'commit' && /^[0-9a-f]{7,40}$/i.test(id || '')) return { kind: 'commit', owner, repo, sha: id };
  return { kind: 'repo', owner, repo };
}

async function gh(path, accept = 'application/vnd.github+json', maxBytes = 1_000_000) {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept,
      'user-agent': 'ForemanToolServer/0.1',
      'x-github-api-version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  const { bytes } = await readCapped(res, maxBytes);
  const text = decodeBytes(bytes);
  if (!res.ok) {
    const limited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
    const msg = limited ? 'GitHub rate limit reached (set GITHUB_TOKEN)' : (() => { try { return JSON.parse(text).message; } catch { return text.slice(0, 200); } })();
    const err = new Error(`GitHub ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  // Raw media types (README, diffs) come back as e.g. 'application/vnd.github.raw+json' but the body is plain text.
  const ct = res.headers.get('content-type') || '';
  return /json/.test(ct) && !/raw|diff/.test(accept) ? JSON.parse(text) : text;
}
const soft = (p) => p.catch(() => null); // secondary lookups must not sink the whole result

const fileRow = (f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions });

/** Combine the legacy commit status and check-runs into one pass/fail/pending line. */
async function ciSummary(owner, repo, sha) {
  const [status, runs] = await Promise.all([
    soft(gh(`/repos/${owner}/${repo}/commits/${sha}/status`)),
    soft(gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=30`)),
  ]);
  if (!status && !runs) return null;
  const checks = (runs?.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
  const failing = checks.filter((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion)).length
    + (status?.state === 'failure' || status?.state === 'error' ? 1 : 0);
  const pending = checks.filter((c) => c.status !== 'completed').length + (status?.state === 'pending' && status.total_count ? 1 : 0);
  const total = checks.length + (status?.total_count || 0);
  return {
    state: total === 0 ? 'none' : failing ? 'failure' : pending ? 'pending' : 'success',
    legacyStatus: status?.total_count ? status.state : null,
    checkRuns: checks.slice(0, 20),
    totalChecks: total,
  };
}

async function pullRequest({ owner, repo, number }) {
  const base = `/repos/${owner}/${repo}/pulls/${number}`;
  const pr = await gh(base);
  const [files, diff, ci] = await Promise.all([
    soft(gh(`${base}/files?per_page=50`)),
    soft(gh(base, 'application/vnd.github.diff', 200_000)),
    ciSummary(owner, repo, pr.head.sha),
  ]);
  return {
    kind: 'pull_request',
    title: pr.title,
    body: clip(pr.body || '', 2000),
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    author: pr.user?.login,
    base: pr.base?.ref,
    head: pr.head?.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    commits: pr.commits,
    files: (files || []).slice(0, 50).map(fileRow),
    diffExcerpt: clip(diff || '', 6000),
    ci,
  };
}

async function commit({ owner, repo, sha }) {
  const c = await gh(`/repos/${owner}/${repo}/commits/${sha}`);
  return {
    kind: 'commit',
    sha: c.sha,
    message: clip(c.commit.message, 2000),
    author: c.commit.author?.name,
    date: c.commit.author?.date,
    stats: c.stats,
    files: (c.files || []).slice(0, 50).map(fileRow),
    ci: await ciSummary(owner, repo, c.sha),
  };
}

async function repository({ owner, repo }) {
  const r = await gh(`/repos/${owner}/${repo}`);
  const [commits, readme] = await Promise.all([
    soft(gh(`/repos/${owner}/${repo}/commits?per_page=1&sha=${encodeURIComponent(r.default_branch)}`)),
    soft(gh(`/repos/${owner}/${repo}/readme`, 'application/vnd.github.raw+json', 20_000)),
  ]);
  const last = commits?.[0];
  return {
    kind: 'repo',
    fullName: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    default_branch: r.default_branch,
    language: r.language,
    pushedAt: r.pushed_at,
    archived: r.archived,
    latestCommit: last && { sha: last.sha, message: clip(last.commit.message, 300), date: last.commit.author?.date },
    readmeExcerpt: clip(readme || '', 3000),
  };
}

export const github = {
  name: 'github',
  method: 'GET',
  path: '/tools/github',
  price: 2000n, // 0.002 USDC
  description: 'Inspect a GitHub deliverable by URL. Pull request: title, body, state, merged, size, changed files, diff excerpt, CI status. Repository: description, stars, default branch, latest commit, README excerpt. Commit: message, stats, files.',
  params: { url: { in: 'query', type: 'string', required: true, description: 'github.com pull request, repository or commit URL' } },

  validate({ url }) {
    return parseGithubUrl(url) ? null : 'url must be a github.com repository, pull request or commit URL';
  },

  async run({ url }) {
    const target = parseGithubUrl(url);
    try {
      const out = target.kind === 'pull_request' ? await pullRequest(target)
        : target.kind === 'commit' ? await commit(target)
          : await repository(target);
      return { ok: true, url, ...out };
    } catch (e) {
      return { ok: false, url, status: e.status ?? 0, error: e.name === 'TimeoutError' ? 'GitHub request timed out' : e.message };
    }
  },
};
