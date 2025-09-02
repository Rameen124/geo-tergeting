const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const UserAgent = require("user-agents");
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
const TARGET_SITE = process.env.TARGET_SITE || "https://havali.xyz";

// ----------------- Proxy Loader -----------------
let proxies = [];
try {
  if (fs.existsSync("proxies.txt")) {
    const proxyData = fs.readFileSync("proxies.txt", "utf-8");
    proxies = proxyData
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Fix common proxy format issues
        if (line.includes("://")) {
          const parts = line.split("://");
          // If there are multiple protocols, use the last one
          if (parts.length > 2) {
            const fixedLine = parts[parts.length - 2] + "://" + parts[parts.length - 1];
            logWarn(`Fixed proxy format: ${line} -> ${fixedLine}`);
            return fixedLine;
          }
          return line;
        }
        // Add default protocol if missing
        return `socks5h://${line}`;
      })
      // Filter out any remaining malformed proxies
      .filter(proxy => {
        const protocolCount = (proxy.match(/:\/\//g) || []).length;
        if (protocolCount > 1) {
          logWarn(`Skipping malformed proxy: ${proxy}`);
          return false;
        }
        return true;
      });

    logInfo(`Loaded ${proxies.length} proxies from proxies.txt`);
  } else {
    logWarn("proxies.txt not found. Running without proxies.");
  }
} catch (err) {
  logError(`Proxy load failed: ${err.message}`);
}

// ----------------- Helpers -----------------
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    "unknown"
  );
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function createSession() {
  const userAgent = new UserAgent();
  return {
    id: uuidv4(),
    proxyIp: null,
    userAgent: userAgent.toString(),
    country: randomPick(["US", "IN", "PK", "UK", "DE", "FR", "CA", "AU"]),
    timezone: randomPick([
      "America/New_York",
      "Europe/London",
      "Asia/Karachi",
      "Asia/Kolkata",
      "Europe/Berlin",
      "Asia/Dubai",
    ]),
  };
}

function getSpoofedHeaders(ip, ua, country, timezone) {
  // More realistic browser headers to avoid detection
  return {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "TE": "Trailers",
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
    "X-Client-IP": ip,
    "X-Forwarded-Host": ip,
    "X-Geo-Country": country,
    "X-Timezone": timezone,
    "Referer": "https://www.google.com/",
  };
}

// ----------------- Proxy Testing -----------------
async function testProxy(proxyUrl) {
  try {
    if (!proxyUrl) return { working: false };

    // Skip testing if proxy URL is malformed
    const protocolCount = (proxyUrl.match(/:\/\//g) || []).length;
    if (protocolCount > 1) {
      logWarn(`Skipping malformed proxy: ${proxyUrl}`);
      return { working: false };
    }

    const fetch = (await import("node-fetch")).default;
    const agent = new SocksProxyAgent(proxyUrl);

    const res = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 5000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { working: true, ip: data.ip };
  } catch (err) {
    logWarn(`Proxy failed (${proxyUrl}): ${err.message}`);
    return { working: false };
  }
}

async function getWorkingProxy() {
  if (proxies.length === 0) return null;

  // Test a random subset of proxies (not all to save time)
  const testProxies = [...proxies].sort(() => 0.5 - Math.random()).slice(0, Math.min(5, proxies.length));
  
  for (let proxy of testProxies) {
    logInfo(`Testing proxy: ${proxy}`);
    const result = await testProxy(proxy);
    if (result.working) {
      logInfo(`Working proxy: ${proxy} (IP: ${result.ip})`);
      return { url: proxy, ip: result.ip };
    }
  }
  logWarn("No working proxy found. Using direct connection.");
  return null;
}

// ----------------- GA Spoof Script -----------------
function getGASpoofScript(session, clientIp) {
  return `
<script>
(function() {
  const originalSendBeacon = navigator.sendBeacon;
  const originalFetch = window.fetch;

  navigator.sendBeacon = function(url, data) {
    if (url.includes('google-analytics.com')) {
      console.log('[GA Spoof] Beacon intercepted:', url);
      // Modify the data if needed
      return originalSendBeacon.call(this, url, data);
    }
    return originalSendBeacon.apply(this, arguments);
  };

  window.fetch = function() {
    const url = arguments[0];
    if (url && typeof url === 'string' && url.includes('google-analytics.com')) {
      console.log('[GA Spoof] Fetch intercepted:', url);
      
      // Add headers to request
      if (arguments[1]) {
        arguments[1].headers = {
          ...arguments[1].headers,
          'X-Forwarded-For': '${session.proxyIp || clientIp}',
          'X-Geo-Country': '${session.country}'
        };
      }
    }
    return originalFetch.apply(this, arguments);
  };
})();
</script>`;
}

// ----------------- Enhanced Fetch with Retry Logic -----------------
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const fetch = (await import("node-fetch")).default;
      const response = await fetch(url, options);
      
      // Check for Cloudflare or other blocking pages
      const body = await response.text();
      if (body.includes('challenge-form') || 
          body.includes('Cloudflare') || 
          body.includes('Please enable cookies') ||
          body.includes('Sorry, you have been blocked')) {
        throw new Error('Site is blocking requests with anti-bot protection');
      }
      
      return { response, body };
    } catch (err) {
      lastError = err;
      logWarn(`Attempt ${i + 1} failed: ${err.message}`);
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  
  throw lastError;
}

// ----------------- Routes -----------------
app.get("/", async (req, res) => {
  const clientIp = getClientIp(req);
  const session = createSession();
  logInfo(`Request from ${clientIp}`);

  try {
    const proxy = await getWorkingProxy();
    let agent = null;
    let proxyIp = "direct";

    if (proxy) {
      session.proxyIp = proxy.ip;
      proxyIp = proxy.ip;
      agent = new SocksProxyAgent(proxy.url);
    }

    const fetchOptions = {
      timeout: 15000,
      headers: getSpoofedHeaders(proxyIp, session.userAgent, session.country, session.timezone),
      ...(agent && { agent }),
      redirect: 'manual', // Handle redirects manually to avoid issues
    };

    const { response, body } = await fetchWithRetry(TARGET_SITE, fetchOptions);

    let modifiedBody = body;
    if (response.headers.get("content-type")?.includes("text/html")) {
      const sessionScript = `
      <script>
        console.log("Proxy: ${proxyIp}");
        console.log("User-Agent: ${session.userAgent}");
        console.log("Country: ${session.country}");
        console.log("Timezone: ${session.timezone}");
      </script>`;
      
      // Inject scripts before closing body tag
      if (modifiedBody.includes("</body>")) {
        modifiedBody = modifiedBody.replace("</body>", sessionScript + getGASpoofScript(session, clientIp) + "</body>");
      } else {
        modifiedBody += sessionScript + getGASpoofScript(session, clientIp);
      }
    }

    // Copy relevant headers from the original response
    const contentType = response.headers.get("content-type") || "text/html";
    res.set("Content-Type", contentType);
    
    // Copy other headers if needed
    if (response.headers.get("cache-control")) {
      res.set("Cache-Control", response.headers.get("cache-control"));
    }

    res.status(response.status).send(modifiedBody);
    logInfo(`Served ${TARGET_SITE} to ${clientIp} via ${proxyIp}`);

  } catch (err) {
    logError(`Fetch error: ${err.message}`);
    res.status(500).send(`
      <h2>Error accessing website</h2>
      <p>${err.message}</p>
      <p>This might be due to:</p>
      <ul>
        <li>Website anti-bot protection (like Cloudflare)</li>
        <li>Proxy server issues</li>
        <li>Network connectivity problems</li>
      </ul>
    `);
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    proxies: proxies.length,
    workingProxies: proxies.filter(p => p.working).length,
    target: TARGET_SITE,
    timestamp: new Date().toISOString(),
  });
});

// ----------------- Start Server -----------------
function startServer(port, host, retries = 10) {
  if (retries <= 0) {
    logError("Failed to start server after multiple attempts");
    process.exit(1);
  }

  const server = app.listen(port, host, () => {
    logInfo(`Server running: http://${host}:${port}`);
    logInfo(`Proxying to: ${TARGET_SITE}`);
  }).on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logWarn(`Port ${port} busy. Retrying on ${port + 1}...`);
      startServer(port + 1, host, retries - 1);
    } else {
      logError(`Server failed: ${err.message}`);
      process.exit(1);
    }
  });

  return server;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logInfo('Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logInfo('Shutting down server...');
  process.exit(0);
});

// Start the server
startServer(PORT, HOST);
