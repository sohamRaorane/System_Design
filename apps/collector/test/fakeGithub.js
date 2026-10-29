'use strict';
// A small fake of github.com + api.github.com for tests: OAuth token exchange, /user,
// GitHub App installation tokens, installations/repos, contents, refs and pull requests.
const http = require('node:http');

function fakeGitHub({ user = { id: 4242, login: 'octo-dev', name: 'Octo Dev', avatar_url: 'https://example.test/a.png' }, repos = {} } = {}) {
  const calls = [];
  const state = {
    user,
    codes: new Map([['good-code', 'gho_user_token_123']]),
    installations: [{ id: 77, account: { login: user.login } }],
    // full_name -> { default_branch, files: { path: content }, private }
    repos: { ...repos },
    refs: new Map(), // `${repo}:${branch}` -> sha
    pulls: [],
    commits: 0,
  };

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const auth = (req) => String(req.headers.authorization || '').replace(/^Bearer /, '');

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'GET' ? {} : await read(req);
    calls.push({ method: req.method, path: u.pathname, auth: auth(req), body });
    const p = u.pathname;
    let m;
    if (p === '/login/oauth/access_token') {
      const tok = state.codes.get(body.code);
      return tok ? json(res, 200, { access_token: tok, token_type: 'bearer', scope: '' }) : json(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    }
    if (p === '/user') return auth(req) === 'gho_user_token_123' ? json(res, 200, state.user) : json(res, 401, { message: 'Bad credentials' });
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p))) {
      if (!auth(req).includes('.')) return json(res, 401, { message: 'A JSON web token could not be decoded' });
      return json(res, 201, { token: 'ghs_install_' + m[1], expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (p === '/user/installations') return json(res, 200, { total_count: state.installations.length, installations: state.installations });
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      const list = Object.entries(state.repos).map(([full, r], i) => ({ id: 1000 + i, full_name: full, name: full.split('/')[1], private: Boolean(r.private), default_branch: r.default_branch || 'main', html_url: `https://github.example/${full}`, language: r.language || null, pushed_at: '2026-10-01T00:00:00Z' }));
      return json(res, 200, { total_count: list.length, repositories: list });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
      const r = state.repos[m[1]];
      return r ? json(res, 200, { full_name: m[1], default_branch: r.default_branch || 'main', html_url: `https://github.example/${m[1]}` }) : json(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(p))) {
      const r = state.repos[m[1]];
      const sha = state.refs.get(`${m[1]}:${m[2]}`) || (r && m[2] === (r.default_branch || 'main') ? 'basesha000' : null);
      return sha ? json(res, 200, { ref: `refs/heads/${m[2]}`, object: { sha } }) : json(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs$/.exec(p)) && req.method === 'POST') {
      const branch = body.ref.replace('refs/heads/', '');
      if (state.refs.has(`${m[1]}:${branch}`)) return json(res, 422, { message: 'Reference already exists' });
      state.refs.set(`${m[1]}:${branch}`, body.sha);
      return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(p))) {
      const r = state.repos[m[1]];
      const file = decodeURIComponent(m[2]);
      if (!r) return json(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') {
        const ref = u.searchParams.get('ref');
        const files = (ref && r.branchFiles?.[ref]) || r.files || {};
        if (!(file in files)) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, { type: 'file', path: file, sha: 'filesha-' + file, encoding: 'base64', content: Buffer.from(files[file]).toString('base64') });
      }
      if (req.method === 'PUT') {
        r.branchFiles = r.branchFiles || {};
        const files = (r.branchFiles[body.branch] = r.branchFiles[body.branch] || { ...(r.files || {}) });
        if (file in files && body.sha !== 'filesha-' + file) return json(res, 409, { message: 'sha mismatch' });
        files[file] = Buffer.from(body.content, 'base64').toString('utf8');
        state.commits++;
        return json(res, 201, { content: { path: file }, commit: { sha: 'c' + state.commits } });
      }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(p)) && req.method === 'POST') {
      const number = state.pulls.length + 1;
      const pr = { number, html_url: `https://github.example/${m[1]}/pull/${number}`, title: body.title, head: body.head, base: body.base, body: body.body, repo: m[1] };
      state.pulls.push(pr);
      return json(res, 201, pr);
    }
    json(res, 404, { message: 'Not Found (fake)' });
  });

  return {
    state,
    calls,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { fakeGitHub };
