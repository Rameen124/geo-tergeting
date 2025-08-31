require('dotenv').config();
const express = require('express');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getSpoofedHeaders, getRandomTimezone } = require('./geo-spoofer');
const UserAgent = require('user-agents');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_SITE = process.env.TARGET_SITE || "https://havali.xyz";
const NODE_ENV = process.env.NODE_ENV || "production";

// In-memory session store with TTL
const sessions = new Map();
const proxyPool = new Map(); // Store tested proxies

// Trust proxy for proper IP handling
app.set('trust proxy', true);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// Serve static files
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// Load proxies with automatic reload
let proxies = loadProxies();
let proxyIndex = 0;

function loadProxies() {
  try {
    return fs.readFileSync("proxies.txt", "utf-8")
      .split("\n")
      .filter(line => line.trim().length > 0)
      .map(proxy => proxy.trim());
  } catch (error) {
    console.error("❌ Error reading proxies file:", error.message);
    return [];
  }
}

// Reload proxies periodically
setInterval(() => {
  const newProxies = loadProxies();
  if (newProxies.length > 0) {
    proxies = newProxies;
    console.log(`🔄 Reloaded ${proxies.length} proxies`);
  }
}, 300000); // Reload every 5 minutes

function getNextProxy() {
  if (proxies.length === 0) {
    throw new Error("No proxies available");
  }
  const proxy = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  return proxy;
}

async function testProxy(proxyUrl) {
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const response = await fetch('https://api.ipify.org?format=json', { 
      agent, 
      timeout: 10000 
    });
    const data = await response.json();
    return { working: true, ip: data.ip };
  } catch (error) {
    return { working: false, error: error.message };
  }
}

// Proxy manager with caching
async function getTestedProxy() {
  // Try to get a pre-tested proxy first
  for (const [proxyUrl, proxyData] of proxyPool.entries()) {
    if (proxyData.working && proxyData.lastTested > Date.now() - 300000) { // 5 minute cache
      return proxyUrl;
    }
  }
  
  // Test new proxies
  for (const proxyUrl of proxies) {
    if (proxyPool.has(proxyUrl) && !proxyPool.get(proxyUrl).working) continue;
    
    const testResult = await testProxy(proxyUrl);
    proxyPool.set(proxyUrl, {
      working: testResult.working,
      ip: testResult.ip,
      lastTested: Date.now()
    });
    
    if (testResult.working) {
      return proxyUrl;
    }
  }
  
  throw new Error("No working proxies available");
}

function generateFingerprint() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > 3600000) { // 1 hour TTL
      sessions.delete(sessionId);
    }
  }
}

function createSession() {
  const sessionId = uuidv4();
  const userAgent = new UserAgent().toString();
  const timezone = getRandomTimezone('US');
  const country = 'US';
  
  const session = {
    sessionId,
    userAgent,
    timezone,
    country,
    fingerprint: generateFingerprint(),
    createdAt: Date.now(),
    proxyAgent: null,
    proxyUrl: null,
    proxyIp: null
  };
  
  sessions.set(sessionId, session);
  cleanupSessions();
  return session;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || 
         req.ip || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// GA Proxy endpoint
app.all('/ga-proxy', async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(400).json({ error: 'Invalid session' });
  }
  
  try {
    // Get or create proxy agent for this session
    if (!session.proxyAgent) {
      const proxyUrl = await getTestedProxy();
      session.proxyAgent = new SocksProxyAgent(proxyUrl);
      session.proxyUrl = proxyUrl;
      
      // Test the proxy to get its IP
      const testResult = await testProxy(proxyUrl);
      if (testResult.working) {
        session.proxyIp = testResult.ip;
      }
    }
    
    const gaEndpoint = req.query.ga_endpoint || '/g/collect';
    const gaUrl = `https://www.google-analytics.com${gaEndpoint}`;
    
    // Prepare headers for GA request
    const headers = {
      'User-Agent': session.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'X-Forwarded-For': session.proxyIp,
      'X-Real-IP': session.proxyIp
    };
    
    // Add referer if available
    if (req.headers['referer']) {
      headers['Referer'] = req.headers['referer'];
    }
    
    // Forward to GA
    const response = await fetch(gaUrl, {
      method: 'POST',
      agent: session.proxyAgent,
      headers: headers,
      body: Object.keys(req.body).map(key => 
        `${key}=${encodeURIComponent(req.body[key])}`
      ).join('&')
    });
    
    // Log success
    console.log(`✅ GA hit via proxy: ${session.proxyIp}`, {
      sessionId: sessionId.substring(0, 8),
      endpoint: gaEndpoint,
      status: response.status
    });
    
    // Forward response
    res.status(response.status);
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    
    res.send(await response.text());
    
  } catch (error) {
    console.error('❌ GA proxy error:', error.message);
    res.status(500).json({ 
      error: 'Error proxying GA request',
      details: error.message 
    });
  }
});

// Visitor endpoint
app.get('/visit', async (req, res) => {
  const clientIp = getClientIp(req);
  console.log(`👤 New visitor from IP: ${clientIp}`);
  
  const session = createSession();
  let attempts = 0;
  const maxAttempts = Math.min(proxies.length, 5);

  while (attempts < maxAttempts) {
    try {
      const proxyUrl = await getTestedProxy();
      console.log(`🌀 Trying Proxy: ${proxyUrl} for session ${session.sessionId}`);

      const proxyTest = await testProxy(proxyUrl);
      if (!proxyTest.working) {
        console.log(`❌ Proxy failed: ${proxyTest.error}`);
        proxies = proxies.filter(p => p !== proxyUrl);
        if (proxies.length === 0) break;
        attempts++;
        continue;
      }
      
      console.log(`✅ Proxy working with IP: ${proxyTest.ip}`);
      session.proxyIp = proxyTest.ip;

      const agent = new SocksProxyAgent(proxyUrl);
      const spoofedHeaders = getSpoofedHeaders(proxyTest.ip, session.userAgent, session.country, session.timezone);

      const response = await fetch(TARGET_SITE, {
        agent,
        timeout: 30000,
        headers: spoofedHeaders
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let body = await response.text();

      // Inject spoof-client.js only if HTML page
      if (response.headers.get('content-type')?.includes('text/html')) {
        const sessionScript = `
          <script>
            window.SESSION_DATA = {
              id: "${session.sessionId}",
              timezone: "${session.timezone}",
              country: "${session.country}",
              fingerprint: "${session.fingerprint}",
              proxyIp: "${session.proxyIp}"
            };
          </script>
          <script src="/assets/spoof-client.js"></script>
        `;
        
        body = body.replace("</body>", sessionScript + "</body>");
      }

      res.set('Content-Type', response.headers.get('content-type') || 'text/html');
      
      console.log(`✅ Successfully served page to ${clientIp} via proxy ${proxyTest.ip}`);
      return res.send(body);

    } catch (err) {
      console.log(`❌ Fetch failed with proxy: ${err.message}`);
      attempts++;
    }
  }

  res.status(500).send(`<h2>All proxies failed. Try again later.</h2>`);
});

// Health endpoint
app.get('/health', async (req, res) => {
  const workingProxies = Array.from(proxyPool.entries())
    .filter(([_, data]) => data.working)
    .map(([url, data]) => ({ url, ip: data.ip }));
  
  res.json({
    status: 'OK',
    sessions: sessions.size,
    workingProxies: workingProxies.length,
    totalProxies: proxies.length,
    proxyDetails: workingProxies
  });
});

// Proxies list endpoint
app.get('/proxies', (req, res) => {
  res.json({
    proxies: proxies,
    count: proxies.length
  });
});

// Spoof test endpoint
app.get('/spoof-test', async (req, res) => {
  const testIp = "8.8.8.8";
  const userAgent = new UserAgent().toString();
  const spoofedHeaders = getSpoofedHeaders(testIp, userAgent, 'US', 'America/New_York');

  res.json({
    message: "Spoofed headers generated successfully",
    testIp,
    spoofedHeaders
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack);
  res.status(500).send('Something broke!');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not found');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running in ${NODE_ENV} mode on port ${PORT}`);
  console.log(`🌍 Visit site: http://localhost:${PORT}/visit`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Proxies list: http://localhost:${PORT}/proxies`);
  console.log(`🧪 Spoof test: http://localhost:${PORT}/spoof-test`);
  
  // Pre-test proxies on startup
  console.log('🧪 Pre-testing proxies...');
  setTimeout(() => {
    proxies.forEach(proxyUrl => {
      testProxy(proxyUrl).then(result => {
        proxyPool.set(proxyUrl, {
          working: result.working,
          ip: result.ip,
          lastTested: Date.now()
        });
        
        if (result.working) {
          console.log(`✅ Proxy OK: ${proxyUrl} → ${result.ip}`);
        }
      });
    });
  }, 1000);
});
