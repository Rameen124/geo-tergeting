const express = require('express');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getSpoofedHeaders, getRandomTimezone } = require('./geo-spoofer');
const UserAgent = require('user-agents');

const app = express();
const PORT = 3000;
const TARGET_SITE = "https://havali.xyz";

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory session store
const sessions = new Map();

// Serve static files
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
  }
}));

// Load proxies
let proxies = [];
try {
  proxies = fs.readFileSync("proxies.txt", "utf-8")
    .split("\n")
    .filter(p => p.trim().length)
    .map(p => p.trim());
  console.log(`✅ Loaded ${proxies.length} proxies`);
} catch (error) {
  console.error("❌ Error reading proxies file:", error.message);
  process.exit(1);
}

let proxyIndex = 0;
function getNextProxy() {
  if (!proxies.length) throw new Error("No proxies available");
  const proxy = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  return proxy;
}

async function testProxy(proxyUrl) {
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const resp = await fetch('https://api.ipify.org?format=json', { agent, timeout: 10000 });
    const data = await resp.json();
    return { working: true, ip: data.ip };
  } catch (err) {
    return { working: false, error: err.message };
  }
}

function generateFingerprint() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 3600000) sessions.delete(id);
  }
}

function createSession() {
  const sessionId = uuidv4();
  const proxyUrl = getNextProxy();
  const userAgent = new UserAgent().toString();
  const timezone = getRandomTimezone('US');
  const country = 'US';
  const session = { sessionId, proxyUrl, userAgent, timezone, country, fingerprint: generateFingerprint(), createdAt: Date.now(), proxyIp: null };
  sessions.set(sessionId, session);
  cleanupSessions();
  return session;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
}

// ---------------- GA Proxy ----------------
app.all('/ga-proxy', async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).send('Invalid session');

  try {
    const agent = new SocksProxyAgent(session.proxyUrl);

    // Test proxy
    const proxyTest = await testProxy(session.proxyUrl);
    if (!proxyTest.working) return res.status(500).send('Proxy not working');
    session.proxyIp = proxyTest.ip;

    const gaEndpoint = req.query.ga_endpoint || '/g/collect';
    const gaUrl = `https://www.google-analytics.com${gaEndpoint}`;

    const headers = {
      'User-Agent': session.userAgent,
      'Content-Type': req.get('Content-Type') || 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      'X-Forwarded-For': session.proxyIp,
      'X-Real-IP': session.proxyIp
    };

    const body = Object.keys(req.body || {}).map(k => `${k}=${encodeURIComponent(req.body[k])}`).join('&');

    const gaResp = await fetch(gaUrl, { method: req.method, headers, body, agent });
    const buffer = await gaResp.arrayBuffer();

    res.status(gaResp.status);
    res.set('Content-Type', gaResp.headers.get('content-type') || 'text/plain');
    res.send(Buffer.from(buffer));

    console.log(`✅ GA proxied via ${session.proxyIp} for session ${sessionId}`);
  } catch (err) {
    console.error('GA proxy error:', err.message);
    res.status(500).send('GA proxy failed');
  }
});

// ---------------- Visitor Page ----------------
app.get('/visit', async (req, res) => {
  const clientIp = getClientIp(req);
  const session = createSession();

  try {
    const proxyTest = await testProxy(session.proxyUrl);
    if (!proxyTest.working) throw new Error('Proxy not working');
    session.proxyIp = proxyTest.ip;

    const agent = new SocksProxyAgent(session.proxyUrl);
    const response = await fetch(TARGET_SITE, { agent, headers: getSpoofedHeaders(session.proxyIp, session.userAgent, session.country, session.timezone) });
    let body = await response.text();

    // Inject spoof-client.js
    const sessionScript = `
      <script>
        window.SESSION_DATA = ${JSON.stringify(session)};
      </script>
      <script src="/assets/spoof-client.js"></script>
    `;
    body = body.replace("</body>", sessionScript + "</body>");

    res.set('Content-Type', response.headers.get('content-type') || 'text/html');
    console.log(`✅ Served page to ${clientIp} via proxy ${session.proxyIp}`);
    res.send(body);
  } catch (err) {
    console.error(`❌ Visitor fetch failed: ${err.message}`);
    res.status(500).send("<h2>All proxies failed. Try again later.</h2>");
  }
});

// ---------------- Health & Debug ----------------
app.get('/health', async (req, res) => {
  const proxyUrl = proxies[0] || '';
  const proxyTest = proxyUrl ? await testProxy(proxyUrl) : { working: false, error: 'No proxies' };
  res.json({ status: 'OK', proxyCount: proxies.length, sessions: sessions.size, proxyTest });
});

app.get('/proxies', (req, res) => res.json({ proxies, count: proxies.length }));

app.get('/spoof-test', async (req, res) => {
  const testIp = "8.8.8.8";
  const ua = new UserAgent().toString();
  res.json({ message: "Spoofed headers test", spoofedHeaders: getSpoofedHeaders(testIp, ua, 'US', 'America/New_York') });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/visit`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Proxies list: http://localhost:${PORT}/proxies`);
  console.log(`🧪 Spoof test: http://localhost:${PORT}/spoof-test`);
});
