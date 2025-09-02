const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const UserAgent = require("user-agents");
require("dotenv").config();

// ----------------- Simple Logging Functions -----------------
function getTimestamp() {
  return new Date().toISOString();
}

function logInfo(message) {
  console.log(`${getTimestamp()} [INFO]: ${message}`);
}

function logWarn(message) {
  console.warn(`${getTimestamp()} [WARN]: ${message}`);
}

function logError(message) {
  console.error(`${getTimestamp()} [ERROR]: ${message}`);
}

// ----------------- App Config -----------------
const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_SITE = process.env.TARGET_SITE || "https://havali.xyz";

// ----------------- Proxy Loader -----------------
let proxies = [];
try {
  if (fs.existsSync("proxies.txt")) {
    const proxyLines = fs.readFileSync("proxies.txt", "utf-8").split("\n");
    
    proxies = proxyLines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Fix double protocol issue (like socks5://socks5h://)
        if (line.includes("://")) {
          // Remove any duplicate protocol prefixes
          const parts = line.split("://");
          if (parts.length > 2) {
            // If there are multiple protocols, keep only the last one
            const fixedProxy = parts[parts.length - 2] + "://" + parts[parts.length - 1];
            logWarn(`Fixed malformed proxy: ${line} -> ${fixedProxy}`);
            return fixedProxy;
          }
          return line;
        } else {
          // Add default protocol if missing
          return `socks5://${line}`;
        }
      })
      .filter(proxy => {
        // Filter out any remaining malformed proxies
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
  logError(`Failed to load proxies: ${err.message}`);
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
  return {
    "User-Agent": ua,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
    "X-Client-IP": ip,
    "X-Forwarded-Host": ip,
    "X-Geo-Country": country,
    "X-Timezone": timezone,
    Referer: "https://www.google.com/",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// ----------------- Proxy Testing -----------------
async function testProxy(proxyUrl) {
  try {
    // Skip testing if proxy URL is malformed
    if (!proxyUrl || (proxyUrl.match(/:\/\//g) || []).length > 1) {
      logWarn(`Skipping malformed proxy: ${proxyUrl}`);
      return { working: false };
    }
    
    const fetch = (await import("node-fetch")).default;
    const agent = new SocksProxyAgent(proxyUrl);

    const res = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 5000, // Reduced timeout for faster testing
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return { working: true, ip: data.ip };
  } catch (err) {
    logWarn(`Proxy ${proxyUrl} failed: ${err.message}`);
    return { working: false };
  }
}

async function getWorkingProxy() {
  if (proxies.length === 0) {
    logWarn("No proxies available. Using direct connection.");
    return null;
  }
  
  // Test a random subset of proxies (not all to save time)
  const testProxies = [...proxies].sort(() => 0.5 - Math.random()).slice(0, 5);
  
  for (let proxy of testProxies) {
    logInfo(`Testing proxy: ${proxy}`);
    const test = await testProxy(proxy);
    if (test.working) {
      logInfo(`Proxy working: ${proxy} (IP: ${test.ip})`);
      return { url: proxy, ip: test.ip };
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
  // Store original functions
  const originalSendBeacon = navigator.sendBeacon;
  const originalFetch = window.fetch;
  
  // Override sendBeacon
  navigator.sendBeacon = function(url, data) {
    if (url.includes('google-analytics.com')) {
      console.log('[GA Spoof] Beacon intercepted:', url);
      // You can modify the data here if needed
      return originalSendBeacon.call(this, url, data);
    }
    return originalSendBeacon.apply(this, arguments);
  };

  // Override fetch
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

    const fetch = (await import("node-fetch")).default;
    const response = await fetch(TARGET_SITE, {
      timeout: 10000,
      headers: getSpoofedHeaders(proxyIp, session.userAgent, session.country, session.timezone),
      ...(agent && { agent }),
    });

    let body = await response.text();

    if (response.headers.get("content-type")?.includes("text/html")) {
      const sessionScript = `
      <script>
        console.log("Proxy: ${proxyIp}");
        console.log("User-Agent: ${session.userAgent}");
        console.log("Country: ${session.country}");
        console.log("Timezone: ${session.timezone}");
      </script>`;
      
      // Generate GA spoof script with current session and client IP
      const gaSpoofScript = getGASpoofScript(session, clientIp);
      body = body.replace("</body>", sessionScript + gaSpoofScript + "</body>");
    }

    res.set("Content-Type", response.headers.get("content-type") || "text/html");
    res.send(body);

    logInfo(`Served ${TARGET_SITE} to ${clientIp} via ${proxyIp}`);
  } catch (err) {
    logError(`Fetch error: ${err.message}`);
    res.status(500).send(`<h2>Error fetching site</h2><p>${err.message}</p>`);
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    proxies: proxies.length,
    target: TARGET_SITE,
    timestamp: new Date().toISOString(),
  });
});

// ----------------- Start Server -----------------
function startServer(port, host, retries = 10) {
  const server = app
    .listen(port, host, () => {
      logInfo(`Server running: http://${host}:${port}`);
      logInfo(`Proxying to: ${TARGET_SITE}`);
    })
    .on("error", (err) => {
      if (err.code === "EADDRINUSE" && retries > 0) {
        logWarn(`Port ${port} busy. Retrying on ${port + 1}...`);
        startServer(port + 1, host, retries - 1);
      } else {
        logError(`Server failed: ${err.message}`);
      }
    });

  return server;
}

startServer(PORT, HOST);
