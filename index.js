const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const UserAgent = require("user-agents");
const cookieParser = require("cookie-parser");
require("dotenv").config();

// ----------------- Logging -----------------
function getTimestamp() {
  return new Date().toISOString();
}

function logInfo(msg) { 
  console.log(`${getTimestamp()} [INFO]: ${msg}`); 
}

function logWarn(msg) { 
  console.warn(`${getTimestamp()} [WARN]: ${msg}`); 
}

function logError(msg) { 
  console.error(`${getTimestamp()} [ERROR]: ${msg}`); 
}

// ----------------- Config -----------------
const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_SITE = process.env.TARGET_SITE || "https://example.com";
const DOMAIN = process.env.DOMAIN || "havali.xyz";

// Add cookie parser middleware
app.use(cookieParser());

// ----------------- Session Storage -----------------
const sessionStore = new Map();

// ----------------- Proxy Management -----------------
let proxies = [];
let workingProxies = [];
let proxyIndex = 0;

function loadProxies() {
  try {
    if (fs.existsSync("proxies.txt")) {
      const proxyData = fs.readFileSync("proxies.txt", "utf-8");
      proxies = proxyData
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          if (!line.includes("://")) {
            return `socks5h://${line}`;
          }
          return line;
        });
      
      logInfo(`Loaded ${proxies.length} proxies from proxies.txt`);
    } else {
      logWarn("proxies.txt not found. Running without proxies.");
    }
  } catch (err) {
    logError(`Proxy load failed: ${err.message}`);
  }
}

async function testProxy(proxyUrl) {
  try {
    const fetch = (await import("node-fetch")).default;
    const agent = new SocksProxyAgent(proxyUrl);
    
    const response = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 5000
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    return { working: true, ip: data.ip, url: proxyUrl };
  } catch (err) {
    return { working: false, error: err.message };
  }
}

async function initializeProxies() {
  loadProxies();
  
  if (proxies.length === 0) {
    logWarn("No proxies available. Running in direct mode.");
    return;
  }
  
  logInfo("Testing proxy pool...");
  
  const testPromises = proxies.map(async (proxy) => {
    const result = await testProxy(proxy);
    if (result.working) {
      workingProxies.push(result);
      logInfo(`✅ Proxy working: ${proxy} (IP: ${result.ip})`);
    } else {
      logWarn(`❌ Proxy failed: ${proxy} - ${result.error}`);
    }
    return result;
  });
  
  await Promise.all(testPromises);
  
  logInfo(`Proxy initialization complete. ${workingProxies.length} of ${proxies.length} proxies working.`);
}

function getNextProxy() {
  if (workingProxies.length === 0) return null;
  
  // Use round-robin for proxy rotation
  const proxy = workingProxies[proxyIndex % workingProxies.length];
  proxyIndex++;
  
  return proxy;
}

// ----------------- Session Management -----------------
function createSession() {
  const userAgent = new UserAgent();
  const viewport = userAgent.data;
  
  return {
    id: uuidv4(),
    proxyIp: null,
    userAgent: userAgent.toString(),
    viewport: {
      width: viewport.width || 1920,
      height: viewport.height || 1080,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      isMobile: viewport.isMobile || false
    },
    language: randomPick(["en-US", "en-GB", "fr-FR", "de-DE", "es-ES"]),
    timezone: randomPick([
      "America/New_York", "Europe/London", "Asia/Karachi", 
      "Asia/Kolkata", "Europe/Berlin", "Asia/Dubai"
    ]),
    platform: randomPick(["Win32", "MacIntel", "Linux x86_64"]),
    hardwareConcurrency: randomPick([4, 8, 12, 16]),
    deviceMemory: randomPick([4, 8, 16]),
    // Store proxy info for GA requests
    proxyUrl: null,
    createdAt: Date.now()
  };
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ----------------- Header Spoofing -----------------
function getSpoofedHeaders(session, proxyIp) {
  return {
    "User-Agent": session.userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Accept-Language": session.language,
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "TE": "Trailers",
    // Override any potential IP leak headers
    "X-Forwarded-For": proxyIp,
    "X-Real-IP": proxyIp,
    "Forwarded": `for=${proxyIp};proto=https`,
    "X-Geo-Country": session.timezone.split('/')[0] === 'America' ? 'US' : 
                     session.timezone.split('/')[0] === 'Europe' ? 'DE' : 'IN',
    "X-Timezone": session.timezone
  };
}

// ----------------- GA Proxy Endpoint -----------------
// This must be defined BEFORE the catch-all handler
app.get("/ga-proxy", async (req, res) => {
  const sessionId = req.cookies.sessionId;
  
  if (!sessionId || !sessionStore.has(sessionId)) {
    logError("GA proxy request without valid session");
    return res.status(400).send("Invalid session");
  }
  
  const session = sessionStore.get(sessionId);
  const gaUrl = req.query.url;
  
  if (!gaUrl || !gaUrl.includes("google-analytics.com")) {
    logError("Invalid GA URL requested");
    return res.status(400).send("Invalid GA URL");
  }
  
  logInfo(`Proxying GA request for session ${sessionId} to ${gaUrl}`);
  
  try {
    let agent = null;
    
    // Use the same proxy that was assigned to this session
    if (session.proxyUrl) {
      agent = new SocksProxyAgent(session.proxyUrl);
      logInfo(`Using session proxy: ${session.proxyUrl} for GA request`);
    }
    
    const fetch = (await import("node-fetch")).default;
    const response = await fetch(gaUrl, {
      agent,
      headers: {
        "User-Agent": session.userAgent,
        "Accept-Language": session.language,
        "X-Forwarded-For": session.proxyIp || "direct"
      },
      timeout: 10000
    });
    
    // GA typically returns a 1x1 pixel or 204 No Content
    res.status(response.status);
    
    // Copy relevant headers
    if (response.headers.get("content-type")) {
      res.set("Content-Type", response.headers.get("content-type"));
    }
    
    // Set CORS headers to allow requests from your domain
    res.set("Access-Control-Allow-Origin", `https://${DOMAIN}`);
    res.set("Access-Control-Allow-Credentials", "true");
    
    // Pipe the response
    response.body.pipe(res);
    
    logInfo(`GA request successful through proxy: ${session.proxyIp}`);
  } catch (err) {
    logError(`GA proxy request failed: ${err.message}`);
    res.status(500).send("GA proxy error");
  }
});

// Allow OPTIONS requests for CORS
app.options("/ga-proxy", (req, res) => {
  res.set("Access-Control-Allow-Origin", `https://${DOMAIN}`);
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
});

// ----------------- Health Endpoint -----------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    proxies: {
      total: proxies.length,
      working: workingProxies.length
    },
    target: TARGET_SITE,
    sessions: sessionStore.size
  });
});

// ----------------- Enhanced Fingerprint Spoofing -----------------
function getFingerprintSpoofScript(session, proxyIp) {
  return `
<script>
// Store session ID for GA proxy requests
const sessionId = "${session.id}";

// Override navigator properties
const originalUserAgent = navigator.userAgent;
Object.defineProperty(navigator, 'userAgent', {
  get: function() { return '${session.userAgent.replace(/'/g, "\\'")}'; },
  configurable: true
});

Object.defineProperty(navigator, 'platform', {
  get: function() { return '${session.platform}'; },
  configurable: true
});

Object.defineProperty(navigator, 'hardwareConcurrency', {
  get: function() { return ${session.hardwareConcurrency}; },
  configurable: true
});

Object.defineProperty(navigator, 'deviceMemory', {
  get: function() { return ${session.deviceMemory}; },
  configurable: true
});

Object.defineProperty(navigator, 'languages', {
  get: function() { return ['${session.language}']; },
  configurable: true
});

// Timezone spoofing
const originalDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = function(locales, options) {
  if (options && options.timeZone) {
    options.timeZone = '${session.timezone}';
  } else {
    options = {...options, timeZone: '${session.timezone}'};
  }
  return new originalDateTimeFormat(locales, options);
};

// Screen properties
Object.defineProperty(screen, 'width', {
  get: function() { return ${session.viewport.width}; },
  configurable: true
});

Object.defineProperty(screen, 'height', {
  get: function() { return ${session.viewport.height}; },
  configurable: true
});

Object.defineProperty(screen, 'availWidth', {
  get: function() { return ${session.viewport.width}; },
  configurable: true
});

Object.defineProperty(screen, 'availHeight', {
  get: function() { return ${session.viewport.height}; },
  configurable: true
});

Object.defineProperty(window, 'devicePixelRatio', {
  get: function() { return ${session.viewport.deviceScaleFactor}; },
  configurable: true
});

// Intercept analytics requests
(function() {
  const originalSendBeacon = navigator.sendBeacon;
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  function proxyGARequest(url, data) {
    // Use our server-side proxy for GA requests
    const proxyUrl = 'https://${DOMAIN}/ga-proxy?url=' + encodeURIComponent(url);
    
    if (data) {
      // For POST requests, we need to send the data to our proxy
      return fetch(proxyUrl, {
        method: 'POST',
        body: data,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        credentials: 'include', // Include cookies
        keepalive: true
      });
    } else {
      // For GET requests
      return fetch(proxyUrl, { 
        credentials: 'include', // Include cookies
        keepalive: true 
      });
    }
  }
  
  navigator.sendBeacon = function(url, data) {
    if (typeof url === 'string' && isAnalyticsRequest(url)) {
      console.log('[GA Proxy] Beacon intercepted:', url);
      return proxyGARequest(url, data);
    }
    return originalSendBeacon.apply(this, arguments);
  };
  
  window.fetch = function() {
    const url = arguments[0];
    if (typeof url === 'string' && isAnalyticsRequest(url)) {
      console.log('[GA Proxy] Fetch intercepted:', url);
      
      // Modify to use our proxy
      const newArgs = [...arguments];
      newArgs[0] = 'https://${DOMAIN}/ga-proxy?url=' + encodeURIComponent(url);
      
      // Ensure credentials are included
      if (!newArgs[1]) newArgs[1] = {};
      newArgs[1].credentials = 'include';
      
      return originalFetch.apply(this, newArgs);
    }
    return originalFetch.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.open = function() {
    this._url = arguments[1];
    return originalXHROpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function(data) {
    if (this._url && isAnalyticsRequest(this._url)) {
      console.log('[GA Proxy] XHR intercepted:', this._url);
      
      // Use our proxy instead
      this._url = 'https://${DOMAIN}/ga-proxy?url=' + encodeURIComponent(this._url);
      
      // Ensure credentials are included
      this.withCredentials = true;
    }
    return originalXHRSend.call(this, data);
  };
  
  function isAnalyticsRequest(url) {
    const analyticsDomains = [
      'google-analytics.com',
      'www.google-analytics.com',
      'stats.g.doubleclick.net',
      'analytics.google.com',
      'ga.jsp',
      'facebook.com/tr',
      'connect.facebook.net',
      'analytics.tiktok.com',
      'ping.edge.tiktok.com'
    ];
    
    return analyticsDomains.some(domain => url.includes(domain));
  }
  
  console.log('GA proxy activated for session:', sessionId);
})();
</script>`;
}

// ----------------- Main Request Handler -----------------
// This must be defined AFTER all specific routes
app.use(async (req, res) => {
  let sessionId = req.cookies.sessionId;
  let session;
  
  // Check if we have an existing session
  if (sessionId && sessionStore.has(sessionId)) {
    session = sessionStore.get(sessionId);
    logInfo(`Reusing existing session: ${sessionId}`);
  } else {
    // Create new session
    session = createSession();
    sessionId = session.id;
    // Set session cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 30 * 60 * 1000, // 30 minutes
      httpOnly: true,
      domain: DOMAIN,
      secure: true,
      sameSite: 'none'
    });
    logInfo(`Created new session: ${sessionId}`);
  }
  
  const clientIp = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  const proxy = getNextProxy();
  let agent = null;
  let proxyIp = "direct";
  
  logInfo(`Request from ${clientIp} for ${req.url} (Session: ${sessionId})`);
  
  try {
    // Use proxy if available
    if (proxy) {
      session.proxyIp = proxy.ip;
      session.proxyUrl = proxy.url; // Store for GA requests
      proxyIp = proxy.ip;
      agent = new SocksProxyAgent(proxy.url);
      logInfo(`✅ Using proxy: ${proxy.url} (IP: ${proxy.ip})`);
    } else {
      logWarn("⚠️ No proxy available, using direct connection");
    }
    
    // Update session in store
    sessionStore.set(sessionId, session);
    
    // Prepare request options
    const fetchOptions = {
      method: req.method,
      headers: getSpoofedHeaders(session, proxyIp),
      redirect: 'follow',
      timeout: 10000,
      compress: true,
      ...(agent && { agent })
    };
    
    // Copy relevant headers from original request
    if (req.headers['accept']) fetchOptions.headers['Accept'] = req.headers['accept'];
    if (req.headers['accept-language']) fetchOptions.headers['Accept-Language'] = req.headers['accept-language'];
    
    // Make the request
    const fetch = (await import("node-fetch")).default;
    const targetUrl = `${TARGET_SITE}${req.originalUrl}`;
    const response = await fetch(targetUrl, fetchOptions);
    
    // Get content type to determine if we should inject scripts
    const contentType = response.headers.get('content-type') || '';
    
    // For HTML responses, we'll inject our spoofing script
    if (contentType.includes('text/html')) {
      let body = await response.text();
      
      // Inject our fingerprint spoofing script before the closing body tag
      if (body.includes('</body>')) {
        body = body.replace('</body>', getFingerprintSpoofScript(session, proxyIp) + '</body>');
      } else {
        body += getFingerprintSpoofScript(session, proxyIp);
      }
      
      // Set appropriate headers
      res.set({
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      
      logInfo(`🚀 Injected spoof script into HTML response`);
      res.status(response.status).send(body);
    } else {
      // For non-HTML content, just pipe it through
      res.set('Content-Type', contentType);
      
      // Copy other headers if needed
      if (response.headers.get('content-length')) {
        res.set('Content-Length', response.headers.get('content-length'));
      }
      
      if (response.headers.get('cache-control')) {
        res.set('Cache-Control', response.headers.get('cache-control'));
      }
      
      response.body.pipe(res);
    }
    
  } catch (err) {
    logError(`Request failed: ${err.message}`);
    
    // If proxy failed, remove it from working pool
    if (proxy) {
      workingProxies = workingProxies.filter(p => p.url !== proxy.url);
      logWarn(`⚠️ Proxy failed, removing from pool: ${proxy.url}`);
      
      // Try to get another proxy for retry
      const newProxy = getNextProxy();
      if (newProxy) {
        logInfo(`Retrying with new proxy: ${newProxy.url}`);
        // You could implement a retry mechanism here
      }
    }
    
    res.status(500).send(`
      <h2>Proxy Error</h2>
      <p>${err.message}</p>
      <p>Please try again. The system will automatically try a different proxy.</p>
    `);
  }
});

// ----------------- Session Cleanup -----------------
// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  let deleted = 0;
  
  for (const [id, session] of sessionStore.entries()) {
    // Sessions older than 1 hour
    if (now - session.createdAt > 60 * 60 * 1000) {
      sessionStore.delete(id);
      deleted++;
    }
  }
  
  if (deleted > 0) {
    logInfo(`Cleaned up ${deleted} old sessions`);
  }
}, 30 * 60 * 1000); // Run every 30 minutes

// ----------------- Initialization -----------------
async function startServer() {
  await initializeProxies();
  
  const server = app.listen(PORT, HOST, () => {
    logInfo(`Server running on http://${HOST}:${PORT}`);
    logInfo(`Proxying requests to: ${TARGET_SITE}`);
  });
  
  return server;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logInfo('Shutting down server...');
  process.exit(0);
});

// Start the server
startServer().catch(err => {
  logError(`Failed to start server: ${err.message}`);
  process.exit(1);
});
