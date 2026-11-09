// Minimal GitHub API client used to write packs, maps and drawings back to the repo.
// The token is a fine-grained personal access token with "Contents: read and write"
// on this repository only. It is kept in this browser's localStorage.

const API = 'https://api.github.com';

export class GitHub {
  constructor(repo, branch) {
    this.repo = repo;
    this.branch = branch || 'main';
    try { this.token = localStorage.getItem('ss14mv.token') || ''; } catch (e) { this.token = ''; }
  }
  setToken(t) {
    this.token = (t || '').trim();
    try { if (this.token) localStorage.setItem('ss14mv.token', this.token); else localStorage.removeItem('ss14mv.token'); } catch (e) { /* ignore */ }
  }
  get ready() { return !!(this.token && this.repo); }

  async req(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + this.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); if (j.message) msg += ': ' + j.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }

  async whoami() { return this.req('GET', '/user'); }

  // read a text file from the branch (null when missing)
  async readText(path) {
    try {
      const j = await this.req('GET', `/repos/${this.repo}/contents/${encodeURI(path)}?ref=${this.branch}`);
      return decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))));
    } catch (e) {
      if (/^404/.test(e.message)) return null;
      throw e;
    }
  }

  // One commit with many files. files: [{path, blob|text}]. onProgress(done, total)
  async commit(files, message, onProgress) {
    const ref = await this.req('GET', `/repos/${this.repo}/git/ref/heads/${this.branch}`);
    const head = await this.req('GET', `/repos/${this.repo}/git/commits/${ref.object.sha}`);
    const tree = [];
    let done = 0;
    const work = files.slice();
    const worker = async () => {
      while (work.length) {
        const f = work.shift();
        const content = f.text != null ? f.text : await blobToBase64(f.blob);
        const b = await this.req('POST', `/repos/${this.repo}/git/blobs`,
          f.text != null ? { content, encoding: 'utf-8' } : { content, encoding: 'base64' });
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
        done++;
        if (onProgress) onProgress(done, files.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const t = await this.req('POST', `/repos/${this.repo}/git/trees`, { base_tree: head.tree.sha, tree });
    const c = await this.req('POST', `/repos/${this.repo}/git/commits`, { message, tree: t.sha, parents: [head.sha] });
    await this.req('PATCH', `/repos/${this.repo}/git/refs/heads/${this.branch}`, { sha: c.sha });
    return c;
  }
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
