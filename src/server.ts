import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { DateTime } from 'luxon';
import { config } from './config';
import { runPipeline } from './pipeline/run';
import crypto from 'crypto';
import { listAccounts, createPost, getPlatformAccountIds } from './services/late';
import { getRecentRuns, addRun } from './run-history';
import {
  getConnectedAccounts,
  setTikTok,
  setFacebook,
  setInstagram,
} from './connected-accounts';

/** Convert "YYYY-MM-DDTHH:mm" in the given IANA timezone to ISO UTC for Late API. */
function toScheduledForISO(dateTimeLocal: string, timezone: string): string | undefined {
  const dt = DateTime.fromFormat(dateTimeLocal.replace('T', ' '), 'yyyy-MM-dd HH:mm', { zone: timezone });
  if (!dt.isValid) return undefined;
  return dt.toUTC().toISO();
}

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
    cb(null, !!ok);
  },
});

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.use('/media', express.static(config.paths.output));
app.use('/tmp', express.static(config.paths.temp));
app.use('/static', express.static(path.join(config.paths.root, 'public')));
app.use('/static', express.static(path.join(config.paths.root, 'public')));

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.session && (req.session as any).loggedIn) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session && (req.session as any).loggedIn) return res.redirect('/');
  res.send(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>InfiNet Automation - Login</title>
<style>body{font-family:system-ui;max-width:360px;margin:80px auto;padding:24px;}input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;}button{width:100%;padding:12px;background:#111;color:#fff;border:0;cursor:pointer;}button:hover{background:#333;}h1{font-size:1.25rem;}.err{color:red;margin-top:8px;}</style>
</head>
<body>
<h1>InfiNet Automation</h1>
<form method="post" action="/login">
  <input type="email" name="email" placeholder="Email" required />
  <input type="password" name="password" placeholder="Password" required />
  <button type="submit">Log in</button>
</form>
<p class="err">${(req.query.err === '1' ? 'Invalid email or password.' : '')}</p>
</body>
</html>
  `);
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!config.adminPasswordHash) {
    return res.redirect('/login?err=1');
  }
  const ok = email === config.adminEmail && (await bcrypt.compare(password, config.adminPasswordHash));
  if (!ok) return res.redirect('/login?err=1');
  (req.session as any).loggedIn = true;
  (req.session as any).email = email;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/login');
});

function randomState(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ----- TikTok OAuth -----
app.get('/auth/tiktok', requireAuth, (req, res) => {
  const { clientKey, redirectUri } = config.direct.tiktok;
  if (!clientKey || !redirectUri) {
    return res.redirect('/?error=tiktok_not_configured');
  }
  const state = randomState();
  (req.session as any).oauthState = state;
  const scope = 'user.info.basic,video.publish';
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(clientKey)}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(url);
});

app.get('/auth/tiktok/callback', requireAuth, async (req, res) => {
  const savedState = (req.session as any)?.oauthState;
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (error || !code || state !== savedState) {
    return res.redirect('/?error=tiktok_denied');
  }
  (req.session as any).oauthState = undefined;
  const { clientKey, clientSecret, redirectUri } = config.direct.tiktok;
  if (!clientKey || !clientSecret || !redirectUri) {
    return res.redirect('/?error=tiktok_not_configured');
  }
  try {
    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      open_id?: string;
      expires_in?: number;
      error?: string;
    };
    if (!tokenRes.ok || !data.access_token) {
      return res.redirect('/?error=tiktok_token_failed');
    }
    const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
    setTikTok({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      openId: data.open_id,
      expiresAt,
    });
    res.redirect('/?connected=tiktok');
  } catch {
    res.redirect('/?error=tiktok_token_failed');
  }
});

// ----- Facebook OAuth -----
app.get('/auth/facebook', requireAuth, (req, res) => {
  const { appId, redirectUri } = config.direct.facebook;
  if (!appId || !redirectUri) {
    return res.redirect('/?error=facebook_not_configured');
  }
  const state = randomState();
  (req.session as any).oauthState = state;
  (req.session as any).oauthProvider = 'facebook';
  const scope = 'pages_show_list,pages_manage_posts,pages_read_engagement';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

app.get('/auth/facebook/callback', requireAuth, async (req, res) => {
  const savedState = (req.session as any)?.oauthState;
  const provider = (req.session as any)?.oauthProvider;
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (provider !== 'facebook' || error || !code || state !== savedState) {
    return res.redirect('/?error=facebook_denied');
  }
  (req.session as any).oauthState = undefined;
  (req.session as any).oauthProvider = undefined;
  const { appId, appSecret, redirectUri } = config.direct.facebook;
  if (!appId || !appSecret || !redirectUri) {
    return res.redirect('/?error=facebook_not_configured');
  }
  try {
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } };
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.redirect('/?error=facebook_token_failed');
    }
    const userToken = tokenData.access_token;
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(userToken)}`
    );
    const pagesData = (await pagesRes.json()) as { data?: { id: string; access_token: string }[]; error?: { message?: string } };
    const pages = pagesData.data || [];
    const page = pages[0];
    if (!page) {
      setFacebook({ accessToken: userToken });
    } else {
      setFacebook({
        accessToken: userToken,
        pageId: page.id,
        pageAccessToken: page.access_token,
      });
    }
    res.redirect('/?connected=facebook');
  } catch {
    res.redirect('/?error=facebook_token_failed');
  }
});

// ----- Instagram OAuth (Meta app, Instagram scopes) -----
app.get('/auth/instagram', requireAuth, (req, res) => {
  const { appId, redirectUri } = config.direct.instagram;
  if (!appId || !redirectUri) {
    return res.redirect('/?error=instagram_not_configured');
  }
  const state = randomState();
  (req.session as any).oauthState = state;
  (req.session as any).oauthProvider = 'instagram';
  const scope = 'pages_show_list,instagram_basic,instagram_content_publish';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

app.get('/auth/instagram/callback', requireAuth, async (req, res) => {
  const savedState = (req.session as any)?.oauthState;
  const provider = (req.session as any)?.oauthProvider;
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (provider !== 'instagram' || error || !code || state !== savedState) {
    return res.redirect('/?error=instagram_denied');
  }
  (req.session as any).oauthState = undefined;
  (req.session as any).oauthProvider = undefined;
  const { appId, appSecret, redirectUri } = config.direct.instagram;
  if (!appId || !appSecret || !redirectUri) {
    return res.redirect('/?error=instagram_not_configured');
  }
  try {
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } };
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.redirect('/?error=instagram_token_failed');
    }
    const userToken = tokenData.access_token;
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,access_token,instagram_business_account&access_token=${encodeURIComponent(userToken)}`
    );
    const pagesData = (await pagesRes.json()) as {
      data?: { id: string; access_token: string; instagram_business_account?: { id: string } }[];
      error?: { message?: string };
    };
    const pages = pagesData.data || [];
    const withIg = pages.find((p) => p.instagram_business_account?.id);
    const page = withIg || pages[0];
    if (!page) {
      setInstagram({ accessToken: userToken });
    } else {
      setInstagram({
        accessToken: page.access_token,
        igUserId: page.instagram_business_account?.id,
      });
    }
    res.redirect('/?connected=instagram');
  } catch {
    res.redirect('/?error=instagram_token_failed');
  }
});

// ----- API: connected status for direct integrations -----
app.get('/api/connected-status', requireAuth, (req, res) => {
  const acc = getConnectedAccounts();
  res.json({
    tiktok: !!(acc.tiktok?.accessToken),
    facebook: !!(acc.facebook?.pageAccessToken || acc.facebook?.accessToken),
    instagram: !!(acc.instagram?.accessToken),
  });
});

function getBrandFoldersList(): { id: number; label: string }[] {
  return config.paths.brandFolders
    .map((dir, id) => ({ id, label: path.basename(dir) }))
    .filter((_, i) => fs.existsSync(config.paths.brandFolders[i]));
}

app.get('/', requireAuth, async (req, res) => {
  const brandFoldersList = getBrandFoldersList();
  const brandOptions = brandFoldersList.map((f) => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join('');
  let accounts: { _id: string; platform: string; username?: string }[] = [];
  let accountsError = '';
  try {
    const data = await listAccounts();
    accounts = data.accounts || [];
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    accountsError = status ? `Late API error (${status}). Try again later.` : 'Could not load accounts.';
  }
  const directAcc = getConnectedAccounts();
  const directTiktok = !!(directAcc.tiktok?.accessToken);
  const directFacebook = !!(directAcc.facebook?.pageAccessToken || directAcc.facebook?.accessToken);
  const directInstagram = !!(directAcc.instagram?.accessToken);
  const tiktokConfig = config.direct.tiktok.clientKey && config.direct.tiktok.redirectUri;
  const facebookConfig = config.direct.facebook.appId && config.direct.facebook.redirectUri;
  const instagramConfig = config.direct.instagram.appId && config.direct.instagram.redirectUri;
  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InfiNet Automation</title>
  <style>
    *{box-sizing:border-box;}
    body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:16px;min-width:0;}
    .header-logo{display:block;max-width:100%;height:auto;margin:0 auto 16px;}
    nav{margin-bottom:16px;}
    .card{background:#f5f5f5;padding:16px;margin:16px 0;border-radius:8px;overflow:hidden;}
    .card h2{font-size:1.15rem;margin-top:0;}
    .card label{display:block;margin-bottom:4px;}
    .card input[type="text"],.card input[type="file"],.card select{width:100%;max-width:100%;padding:10px;margin:0 0 12px;border:1px solid #ccc;border-radius:6px;font-size:1rem;}
    .card select{padding:10px;}
    button{padding:10px 20px;background:#111;color:#fff;border:0;cursor:pointer;border-radius:6px;font-size:1rem;}
    button:hover{background:#333;}
    button:disabled{opacity:0.6;cursor:not-allowed;}
    a.btn-connect{display:inline-block;padding:10px 20px;background:#111;color:#fff;border:0;cursor:pointer;border-radius:6px;font-size:1rem;text-decoration:none;margin-right:8px;margin-bottom:8px;}
    a.btn-connect:hover{background:#333;}
    .out{white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto;}
    a{color:#06c;}
    .schedule-field{width:220px;max-width:100%;box-sizing:border-box;}
    .card select.schedule-field{width:220px;max-width:100%;}
  </style>
</head>
<body>
<header>
  <img src="/static/feature-graphic.png" alt="InfiNet" class="header-logo" width="280" height="auto">
</header>
<nav><a href="/">Dashboard</a> | <form method="post" action="/logout" style="display:inline;"><button type="submit">Logout</button></form></nav>
<p id="flash" style="margin:0 0 12px 0;padding:8px 12px;border-radius:6px;display:none;"></p>
<div class="card">
  <h2>Run pipeline</h2>
  <p style="margin-top:0;color:#666;font-size:0.9rem;">Leave schedule empty to post immediately. Set date and time to schedule; you can submit multiple times to schedule multiple posts.</p>
  <form id="runForm">
    <p><label>Brand folder</label><select name="brandFolderId" id="brandFolderId" class="schedule-field"><option value="">Any (first with images)</option>${brandOptions}</select></p>
    <p><label>Topic</label><input type="text" name="topic" placeholder="e.g. AI tip of the day" /></p>
    <p><label>Product hint (optional)</label><input type="text" name="productHint" placeholder="e.g. InfiNet AI" /></p>
    <p><label>Schedule for (optional)</label><input type="datetime-local" name="scheduledFor" id="scheduledFor" class="schedule-field" /></p>
    <p><label>Timezone (for schedule)</label><select name="timezone" id="timezone" class="schedule-field"><option value="UTC">UTC</option><option value="America/New_York">Eastern (US)</option><option value="America/Los_Angeles">Pacific (US)</option><option value="Europe/London">London</option><option value="Europe/Paris">Paris</option><option value="Asia/Dubai">Dubai</option><option value="Asia/Tokyo">Tokyo</option></select></p>
    <button type="submit" id="runBtn">Generate &amp; post</button>
  </form>
  <div id="out" class="out" style="margin-top:12px;"></div>
</div>
<div class="card">
  <h2>Upload images to brand folder</h2>
  <p>Choose a brand folder and upload image(s) from your computer. They will be used as style references when the folder is selected.</p>
  <div id="uploadForm">
    <p><label>Brand folder</label><select id="uploadBrandFolderId" class="schedule-field" required>${brandOptions}</select></p>
    <p><label>Images</label><input type="file" id="uploadImages" accept="image/jpeg,image/png,image/webp,image/gif" multiple /></p>
    <button type="button" id="uploadBtn" onclick="doUpload()">Upload</button>
  </div>
  <div id="uploadOut" class="out" style="margin-top:12px;"></div>
</div>
<div class="card">
  <h2>Generated posts</h2>
  <p id="retryRow" style="display:none;margin:0 0 12px 0;"><button type="button" id="retryLastBtn">Retry posting (last run)</button> <span id="retryOut" class="out"></span></p>
  <div id="generatedPosts">Loading…</div>
</div>
<div class="card">
  <h2>Connect accounts (direct API)</h2>
  <p style="margin-top:0;color:#666;font-size:0.9rem;">Connect your own TikTok, Facebook, or Instagram via their official APIs. When connected, the pipeline can post to these platforms directly instead of (or alongside) Late.</p>
  <p style="margin:12px 0 8px 0;">
    ${directTiktok ? '<span style="color:green">TikTok: Connected</span>' : '<a href="/auth/tiktok" class="btn-connect">Connect TikTok</a>'}
    ${directFacebook ? ' <span style="color:green">Facebook: Connected</span>' : ' <a href="/auth/facebook" class="btn-connect">Connect Facebook</a>'}
    ${directInstagram ? ' <span style="color:green">Instagram: Connected</span>' : ' <a href="/auth/instagram" class="btn-connect">Connect Instagram</a>'}
  </p>
  <p style="margin-top:12px;font-size:0.85rem;color:#666;">To enable the Connect buttons, add these to <strong>.env</strong> on the server (<code>/var/www/infinet.services/automation/.env</code>), then run <code>pm2 restart infinet-automation</code>:</p>
  <ul style="font-size:0.85rem;color:#444;margin:4px 0 0 0;padding-left:20px;">
    <li><strong>TikTok:</strong> TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI (e.g. https://automation.infinet.services/auth/tiktok/callback)</li>
    <li><strong>Facebook:</strong> FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_REDIRECT_URI (e.g. https://automation.infinet.services/auth/facebook/callback)</li>
    <li><strong>Instagram:</strong> same as Facebook, or INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_REDIRECT_URI (e.g. https://automation.infinet.services/auth/instagram/callback)</li>
  </ul>
</div>
<div class="card">
  <h2>Connected accounts (Late API)</h2>
  <ul>
    ${accounts.map((a) => `<li><strong>${a.platform}</strong> ${a.username || a._id}</li>`).join('')}
    ${accounts.length === 0 ? '<li>' + (accountsError || 'None or not configured. Set LATE_ACCOUNT_* in .env') + '</li>' : ''}
  </ul>
  <p style="margin-top:8px;color:#666;font-size:0.9rem;">You can use Late and/or direct API: if a platform is connected above (direct), it may be used for posting; otherwise Late account IDs here are used.</p>
</div>
<script>
  async function loadGeneratedPosts() {
    const el = document.getElementById('generatedPosts');
    try {
      const r = await fetch('/api/runs');
      const runs = await r.json();
      if (!runs.length) {
        document.getElementById('retryRow').style.display = 'none';
        el.innerHTML = '<p>No runs yet. Use &quot;Run pipeline&quot; above to generate and post.</p>';
        return;
      }
      document.getElementById('retryRow').style.display = 'block';
      el.innerHTML = runs.map(run => {
        const date = new Date(run.createdAt).toLocaleString();
        const scheduledLabel = run.scheduledFor ? ' <span style="color:#0066cc">• Scheduled for ' + escapeHtml(new Date(run.scheduledFor).toLocaleString()) + '</span>' : '';
        return '<div class="run-card" style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0;display:flex;gap:12px;align-items:flex-start;">' +
          '<div style="flex:0 0 120px;"><a href="' + run.imageUrl + '" target="_blank" rel="noopener"><img src="' + run.imageUrl + '" alt="Generated" style="width:100%;height:auto;border-radius:6px;object-fit:cover;max-height:80px;" onerror="this.style.display=&quot;none&quot;"></a></div>' +
          '<div style="flex:1;min-width:0;">' +
          '<strong>' + escapeHtml(run.topic) + '</strong>' + (run.productHint ? ' <span style="color:#666">(' + escapeHtml(run.productHint) + ')</span>' : '') + '<br>' +
          '<small style="color:#666">' + escapeHtml(date) + '</small><br>' +
          '<a href="' + run.imageUrl + '" target="_blank" rel="noopener">Image</a> | <a href="' + run.videoUrl + '" target="_blank" rel="noopener">Video</a>' +
          (run.postedImage || run.postedVideo ? ' <span style="color:green">• Posted</span>' : '') + scheduledLabel +
          '</div></div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<p>Could not load runs.</p>';
    }
  }
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
  function doUpload() {
    var btn = document.getElementById('uploadBtn');
    var out = document.getElementById('uploadOut');
    var folderId = document.getElementById('uploadBrandFolderId');
    var fileInput = document.getElementById('uploadImages');
    out.textContent = 'Starting upload...';
    if (!folderId || !folderId.value) { out.textContent = 'Select a brand folder.'; return; }
    if (!fileInput || !fileInput.files || !fileInput.files.length) { out.textContent = 'Select at least one image.'; return; }
    btn.disabled = true;
    out.textContent = 'Uploading...';
    var formData = new FormData();
    formData.append('brandFolderId', folderId.value);
    for (var i = 0; i < fileInput.files.length; i++) formData.append('images', fileInput.files[i]);
    fetch('/api/upload', { method: 'POST', body: formData, credentials: 'same-origin' })
      .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(result) {
        out.textContent = result.ok ? ('Uploaded ' + (result.data.uploaded || 0) + ' image(s) to ' + (result.data.folder || '') + '.') : ('Error: ' + (result.data.error || result.data.message || 'Upload failed'));
        if (result.ok && fileInput) fileInput.value = '';
      })
      .catch(function(err) {
        out.textContent = 'Error: ' + (err.message || 'Network error');
      })
      .finally(function() { btn.disabled = false; });
  }
  (function showFlash() {
    var flash = document.getElementById('flash');
    var q = window.location.search || '';
    if (q.indexOf('connected=') !== -1) {
      var m = q.match(/connected=([^&]+)/);
      flash.textContent = m && m[1] ? (m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' connected.') : 'Connected.';
      flash.style.display = 'block';
      flash.style.background = '#d4edda';
      flash.style.color = '#155724';
      if (history.replaceState) history.replaceState(null, '', window.location.pathname);
    } else if (q.indexOf('error=') !== -1) {
      var em = q.match(/error=([^&]+)/);
      var code = em && em[1] ? em[1] : '';
      var messages = {
        'tiktok_not_configured': 'TikTok connect not set up. Add TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI to .env on the server and restart the app.',
        'tiktok_denied': 'TikTok connection was cancelled or denied.',
        'tiktok_token_failed': 'TikTok could not complete sign-in. Check your .env keys and try again.',
        'facebook_not_configured': 'Facebook connect not set up. Add FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and FACEBOOK_REDIRECT_URI to .env on the server and restart the app.',
        'facebook_denied': 'Facebook connection was cancelled or denied.',
        'facebook_token_failed': 'Facebook could not complete sign-in. Check your .env keys and try again.',
        'instagram_not_configured': 'Instagram connect not set up. Add FACEBOOK_APP_ID (or INSTAGRAM_APP_ID), app secret, and redirect URI to .env on the server and restart the app.',
        'instagram_denied': 'Instagram connection was cancelled or denied.',
        'instagram_token_failed': 'Instagram could not complete sign-in. Check your .env keys and try again.'
      };
      var msg = messages[code] || code.replace(/_/g, ' ') || 'Something went wrong.';
      flash.textContent = msg;
      flash.style.display = 'block';
      flash.style.background = '#f8d7da';
      flash.style.color = '#721c24';
      if (history.replaceState) history.replaceState(null, '', window.location.pathname);
    }
  })();
  loadGeneratedPosts();
  document.getElementById('retryLastBtn').onclick = async function() {
    const btn = document.getElementById('retryLastBtn');
    const out = document.getElementById('retryOut');
    btn.disabled = true;
    out.textContent = 'Sending…';
    try {
      const r = await fetch('/api/retry-last', { method: 'POST', credentials: 'same-origin' });
      const data = await r.json();
      if (r.ok) {
        out.textContent = data.message || 'Done.';
        out.style.color = 'green';
        loadGeneratedPosts();
      } else {
        out.textContent = data.error || 'Failed';
        out.style.color = 'red';
      }
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || 'Network error');
      out.style.color = 'red';
    }
    btn.disabled = false;
  };
  document.getElementById('runForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('runBtn');
    const out = document.getElementById('out');
    btn.disabled = true;
    out.textContent = 'Running pipeline...';
    try {
      const topic = document.querySelector('[name=topic]').value;
      const productHint = document.querySelector('[name=productHint]').value;
      const brandFolderIdRaw = document.querySelector('[name=brandFolderId]').value;
      const brandFolderId = brandFolderIdRaw === '' ? undefined : parseInt(brandFolderIdRaw, 10);
      const scheduledForInput = document.querySelector('[name=scheduledFor]');
      const timezoneInput = document.querySelector('[name=timezone]');
      const scheduledForVal = scheduledForInput && scheduledForInput.value ? scheduledForInput.value.trim() : undefined;
      const timezoneVal = timezoneInput && timezoneInput.value ? timezoneInput.value : undefined;
      const r = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          productHint,
          brandFolderId: isNaN(brandFolderId) ? undefined : brandFolderId,
          scheduledFor: scheduledForVal || undefined,
          timezone: timezoneVal || undefined
        })
      });
      const data = await r.json();
      out.textContent = r.ok ? ('Done. ' + JSON.stringify(data, null, 2)) : ('Error: ' + (data.error || r.status));
      if (r.ok) loadGeneratedPosts();
    } catch (err) {
      out.textContent = 'Error: ' + err.message;
    }
    btn.disabled = false;
  };
</script>
</body>
</html>
  `);
});

app.get('/api/brand-folders', requireAuth, (req, res) => {
  try {
    const list = config.paths.brandFolders
      .map((dir, id) => ({ id, label: path.basename(dir), path: dir }))
      .filter(({ path: dir }) => fs.existsSync(dir));
    res.json(list);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.post('/api/upload', requireAuth, uploadMem.fields([{ name: 'brandFolderId', maxCount: 1 }, { name: 'images', maxCount: 50 }]), (req, res) => {
  try {
    const rawId = (req.body as { brandFolderId?: string }).brandFolderId;
    const folderIndex = typeof rawId === 'string' ? parseInt(rawId, 10) : NaN;
    if (isNaN(folderIndex) || folderIndex < 0 || folderIndex >= config.paths.brandFolders.length) {
      return res.status(400).json({ error: 'Invalid brand folder' });
    }
    const dir = config.paths.brandFolders[folderIndex];
    if (!fs.existsSync(dir)) {
      return res.status(400).json({ error: 'Brand folder not found on server' });
    }
    const files = (req.files as { images?: Express.Multer.File[] })?.images ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No images selected' });
    }
    const dirResolved = path.resolve(dir);
    let uploaded = 0;
    const ts = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = path.extname(f.originalname) || '.jpg';
      const base = `upload_${ts}_${i}${ext}`;
      const dest = path.join(dirResolved, base);
      if (!dest.startsWith(dirResolved)) continue;
      fs.writeFileSync(dest, f.buffer);
      uploaded++;
    }
    res.json({ uploaded, folder: path.basename(dir) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.get('/api/runs', requireAuth, (req, res) => {
  try {
    const runs = getRecentRuns(50);
    res.json(runs);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.post('/api/run', requireAuth, async (req, res) => {
  try {
    const { topic, productHint, brandFolderId, scheduledFor, timezone } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic required' });
    }
    const baseUrl = (process.env.BASE_URL || `http://localhost:${config.port}`).replace(/\/$/, '');
    const brandFolderIndex = typeof brandFolderId === 'number' && brandFolderId >= 0 ? brandFolderId : undefined;
    const scheduledForRaw = typeof scheduledFor === 'string' && scheduledFor.trim() ? scheduledFor.trim() : undefined;
    const timezoneStr = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : undefined;
    let scheduledForStr: string | undefined;
    if (scheduledForRaw && timezoneStr) {
      scheduledForStr = toScheduledForISO(scheduledForRaw, timezoneStr) ?? undefined;
    } else if (scheduledForRaw?.endsWith('Z')) {
      scheduledForStr = scheduledForRaw;
    } else {
      scheduledForStr = undefined;
    }
    const result = await runPipeline({
      topic: topic.trim(),
      productHint: productHint?.trim(),
      baseUrl,
      brandFolderIndex,
      scheduledFor: scheduledForStr,
      timezone: timezoneStr,
    });
    addRun({
      topic: topic.trim(),
      productHint: productHint?.trim() || undefined,
      imageUrl: `${baseUrl}/media/${path.basename(result.imagePath)}`,
      videoUrl: `${baseUrl}/media/${path.basename(result.videoWithAudioPath)}`,
      caption: result.caption?.slice(0, 200) || '',
      postedImage: result.postedImage,
      postedVideo: result.postedVideo,
      scheduledFor: result.scheduledFor,
    });
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post('/api/retry-last', requireAuth, async (req, res) => {
  try {
    const runs = getRecentRuns(1);
    if (runs.length === 0) return res.status(400).json({ error: 'No run to retry. Generate a post first.' });
    const last = runs[0];
    const direct = getConnectedAccounts();
    const directTiktok = !!(direct.tiktok?.accessToken);
    const ids = getPlatformAccountIds();
    const platforms = [
      ids.instagram && { platform: 'instagram' as const, accountId: ids.instagram },
      ids.facebook && { platform: 'facebook' as const, accountId: ids.facebook },
      ids.tiktok && !directTiktok && { platform: 'tiktok' as const, accountId: ids.tiktok },
      ids.twitter && { platform: 'twitter' as const, accountId: ids.twitter },
    ].filter(Boolean) as { platform: 'instagram' | 'facebook' | 'tiktok' | 'twitter'; accountId: string }[];
    const hasAny = platforms.length > 0 || directTiktok;
    if (!hasAny) return res.status(400).json({ error: 'No posting target. Connect TikTok/Facebook/Instagram (direct or Late).' });
    const imagePlatforms = platforms.filter((p) => p.platform === 'facebook' || p.platform === 'twitter');
    const videoPlatforms = platforms.filter((p) => p.platform === 'instagram' || p.platform === 'tiktok');
    const caption = last.caption || '';
    if (imagePlatforms.length > 0) {
      await createPost({
        content: caption,
        mediaItems: [{ type: 'image', url: last.imageUrl }],
        platforms: imagePlatforms,
        publishNow: true,
      });
    }
    if (videoPlatforms.length > 0) {
      await createPost({
        content: caption,
        mediaItems: [{ type: 'video', url: last.videoUrl }],
        platforms: videoPlatforms.map((p) =>
          p.platform === 'instagram' ? { ...p, platformSpecificData: { contentType: 'reel' } } : p
        ),
        publishNow: true,
      });
    }
    if (directTiktok) {
      const { postVideoDirect } = await import('./services/tiktok-direct');
      await postVideoDirect({ videoUrl: last.videoUrl, caption });
    }
    res.json({ ok: true, message: 'Retry sent to all platforms.' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`InfiNet Automation running at http://localhost:${PORT}`);
  if (!config.adminPasswordHash) {
    console.warn('Set ADMIN_PASSWORD_HASH (bcrypt) and SESSION_SECRET in .env for login.');
  }
});
