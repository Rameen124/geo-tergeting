const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

// ----------------- Simple Logger -----------------
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
    proxies = fs
      .readFileSync("proxies.txt", "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) =>
        line.startsWith("socks5://") ||
        line.startsWith("socks4://") ||
        line.startsWith("http://")
          ? line
          : `socks5://${line}`
      );
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
  return {
    id: uuidv4(),
    proxyIp: null,
    userAgent: randomPick([
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile Safari/604.1",
    ]),
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
    const fetch = (await import("node-fetch")).default;
    const agent = new SocksProxyAgent(proxyUrl);

    const res = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 8000,
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
  for (let proxy of proxies) {
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
  const originalSendBeacon = navigator.sendBeacon;
  navigator.sendBeacon = function(url, data) {
    if (url.includes('google-analytics.com')) {
      console.log('[GA Spoof] Beacon:', url);
      return originalSendBeacon.call(this, url, data);
    }
    return originalSendBeacon.apply(this, arguments);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && url.includes('google-analytics.com')) {
      const originalSend = this.send;
      this.send = function(data) {
        this.setRequestHeader('X-Forwarded-For', '${session.proxyIp || clientIp}');
        this.setRequestHeader('X-Geo-Country', '${session.country}');
        return originalSend.apply(this, arguments);
      };
    }
    return originalXHROpen.apply(this, arguments);
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
      timeout: 30000,
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
