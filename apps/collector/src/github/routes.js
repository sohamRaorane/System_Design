'use strict';
// "Connect a repository" (/api/github/*, /api/projects/:pid/repo*).
//
// Access model: the user installs our GitHub App on the repositories they choose. We list
// repos with the user's own token (so we only ever show what *they* can see through *their*
// installations) and write with the installation token (so the App's permissions — contents
// and pull requests on selected repos — are the ceiling).
const express = require('express');
const { planInstrumentation, ROOT_FILES } = require('./instrument');
const { safeNext } = require('../auth/routes');

const BRANCH = 'tracepipe/opentelemetry';
const FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function githubRouter(ctx) {
  const { env, github, accounts, projects, auth, logger } = ctx;
  const router = express.Router();
  const json = express.json({ limit: '20kb' });

  const explain = (err, res) => {
    const status = err.status === 401 ? 401 : err.status === 404 ? 404 : err.status === 403 ? 403 : 502;
    const message = err.status === 401 ? 'GitHub no longer accepts your sign-in. Sign out and sign in with GitHub again.'
      : err.status === 403 ? 'The GitHub App does not have permission for this repository. Check the App\'s repository access on GitHub.'
        : err.status === 404 ? 'GitHub could not find that repository through your installation.'
          : `GitHub request failed: ${err.message}`;
    logger?.warn?.('github:', err.status, err.message);
    res.status(status).json({ error: 'github', message });
  };

  /** The user's GitHub token, or an explanation of why there is none. */
  const userToken = async (req, res) => {
    if (!env.githubAppEnabled) { res.status(503).json({ error: 'github_app_not_configured', message: 'The GitHub App is not configured on this collector (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG).' }); return null; }
    const token = await accounts.githubToken(req.user.id);
    if (!token) { res.status(409).json({ error: 'github_sign_in_required', message: 'Sign in with GitHub to connect a repository.' }); return null; }
    return token;
  };

  const loadOwnProject = async (req, res) => {
    const p = await projects.get(req.params.pid);
    if (!p || p.owner_id !== req.user.id) { res.status(404).json({ error: 'not_found' }); return null; }
    return p;
  };

  // GitHub sends people here after they install (or change) the App: back to the dashboard.
  router.get('/api/github/setup', (req, res) => {
    res.redirect(302, `${env.webOrigin || ''}${safeNext(req.query.state)}`);
  });

  router.get('/api/github/installations', auth.requireUser, async (req, res) => {
    const token = await userToken(req, res);
    if (!token) return;
    try {
      const list = await github.userInstallations(token);
      res.json({
        installations: list.map((i) => ({ id: i.id, account: i.account?.login, avatar_url: i.account?.avatar_url, repository_selection: i.repository_selection })),
        install_url: github.installUrl(String(req.query.next || '')),
      });
    } catch (err) { explain(err, res); }
  });

  router.get('/api/github/installations/:iid/repos', auth.requireUser, async (req, res) => {
    const token = await userToken(req, res);
    if (!token) return;
    try {
      const repos = await github.installationRepos(token, req.params.iid);
      res.json({ repos: repos.map((r) => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, language: r.language, html_url: r.html_url, pushed_at: r.pushed_at })) });
    } catch (err) { explain(err, res); }
  });

  /** Link a repository to a project: verify access, read root files, detect the stack. */
  router.post('/api/projects/:pid/repo', auth.requireUser, json, async (req, res) => {
    const project = await loadOwnProject(req, res);
    if (!project) return;
    const token = await userToken(req, res);
    if (!token) return;
    const fullName = String(req.body?.full_name || '');
    const installationId = Number(req.body?.installation_id);
    const dotSegment = fullName.split('/').some((part) => part === '.' || part === '..');
    if (!FULL_NAME.test(fullName) || dotSegment || !Number.isInteger(installationId)) return res.status(400).json({ error: 'invalid_repo' });
    try {
      // Only repos the *user* can reach through this installation are accepted.
      const visible = await github.installationRepos(token, installationId);
      if (!visible.some((r) => r.full_name.toLowerCase() === fullName.toLowerCase())) return res.status(404).json({ error: 'not_found', message: 'That repository is not available through your GitHub App installation.' });
      const inst = await github.installationToken(installationId);
      const repo = await github.getRepo(inst, fullName);
      const files = await readRootFiles(github, inst, fullName, repo.default_branch);
      const plan = planInstrumentation(files, { serviceName: defaultServiceName(fullName), endpoint: env.publicUrl });
      await ctx.db.run('UPDATE projects SET repo_full_name = ?, repo_installation_id = ?, repo_stack = ?, pr_url = NULL, pr_branch = NULL WHERE id = ?', [repo.full_name, installationId, plan.stack.label, project.id]);
      res.json({ repo: { full_name: repo.full_name, default_branch: repo.default_branch, html_url: repo.html_url }, stack: plan.stack, changes: plan.changes.map((c) => ({ path: c.path, why: c.why })), notes: plan.notes });
    } catch (err) { explain(err, res); }
  });

  /** Open the instrumentation pull request. */
  router.post('/api/projects/:pid/repo/pull-request', auth.requireUser, json, async (req, res) => {
    const project = await loadOwnProject(req, res);
    if (!project) return;
    if (!project.repo_full_name) return res.status(400).json({ error: 'no_repo', message: 'Choose a repository first.' });
    if (!env.githubAppEnabled) return res.status(503).json({ error: 'github_app_not_configured' });
    const serviceName = String(req.body?.service_name || defaultServiceName(project.repo_full_name)).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60) || 'app';
    const fullName = project.repo_full_name;
    try {
      const inst = await github.installationToken(project.repo_installation_id);
      const repo = await github.getRepo(inst, fullName);
      const base = repo.default_branch;
      const files = await readRootFiles(github, inst, fullName, base);
      const plan = planInstrumentation(files, { serviceName, endpoint: env.publicUrl });
      const sha = await github.branchSha(inst, fullName, base);
      const branch = await github.createBranch(inst, fullName, BRANCH, sha);
      for (const change of plan.changes) {
        const existing = await github.readFile(inst, fullName, change.path, branch);
        if (existing && existing.text === change.content) continue;
        await github.putFile(inst, fullName, {
          path: change.path, content: change.content, branch, sha: existing?.sha,
          message: change.path === 'OPENTELEMETRY.md' ? 'docs: explain the OpenTelemetry setup' : `chore: add OpenTelemetry to ${change.path}`,
        });
      }
      const pr = await github.createPull(inst, fullName, {
        title: 'Add OpenTelemetry tracing',
        head: branch,
        base,
        body: prBody({ plan, serviceName, dashboard: env.webOrigin ? `${env.webOrigin}/p/${project.id}/overview` : null }),
      });
      await ctx.db.run('UPDATE projects SET pr_url = ?, pr_branch = ?, repo_stack = ? WHERE id = ?', [pr.html_url, branch, plan.stack.label, project.id]);
      res.status(201).json({ pull_request: { url: pr.html_url, number: pr.number, branch }, service_name: serviceName, notes: plan.notes });
    } catch (err) { explain(err, res); }
  });

  router.delete('/api/projects/:pid/repo', auth.requireUser, async (req, res) => {
    const project = await loadOwnProject(req, res);
    if (!project) return;
    await ctx.db.run('UPDATE projects SET repo_full_name = NULL, repo_installation_id = NULL, repo_stack = NULL, pr_url = NULL, pr_branch = NULL WHERE id = ?', [project.id]);
    res.json({ ok: true });
  });

  return router;
}

async function readRootFiles(github, token, fullName, ref) {
  const files = {};
  await Promise.all(ROOT_FILES.map(async (f) => {
    const r = await github.readFile(token, fullName, f, ref);
    if (r) files[f] = r.text;
  }));
  return files;
}

const defaultServiceName = (fullName) => fullName.split('/')[1].toLowerCase().replace(/[^a-z0-9._-]/g, '-');

function prBody({ plan, serviceName, dashboard }) {
  return `This pull request adds **OpenTelemetry** tracing using zero-code instrumentation (${plan.stack.label}).

${plan.changes.map((c) => `- \`${c.path}\`: ${c.why}`).join('\n')}

**After merging**, set the environment variables listed in \`OPENTELEMETRY.md\` where the app runs
(service name: \`${serviceName}\`), take the ingest key from the dashboard, and deploy.
No secrets are included in this pull request.
${plan.notes.length ? `\n**Notes**\n${plan.notes.map((n) => `- ${n}`).join('\n')}\n` : ''}${dashboard ? `\nDashboard: ${dashboard}\n` : ''}
_Opened by Tracepipe._`;
}

module.exports = { githubRouter, BRANCH };
