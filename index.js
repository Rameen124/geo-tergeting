const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const winston = require("winston");
require("dotenv").config();

// ----------------- Logging -----------------
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_SITE = process.env.TARGET_SITE || "https://havali.xyz";

// ----------------- Load Proxies -----------------
let proxies = [];
try {
  if (fs.existsSync("proxies.txt")) {
    proxies = fs
      .readFileSync("proxies.txt", "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        if (
          !line.startsWith("socks5://") &&
          !line.startsWith("socks4://") &&
          !line.startsWith("http://")
        ) {
          return `socks5://${line}`;
        }
        return line;
      });
    logger.info(`Loaded ${proxies.length} proxies from proxies.txt`);
  } else {
    logger.warn("proxies.txt not found. Running without proxies.");
  }
} catch (err) {
  logger.error("Error loading proxies:", err.message);
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

function createSession() {
  return {
    id: uuidv4(),
    proxyIp: null,
    userAgent: getRandomUserAgent(),
    country: getRandomCountry(),
    timezone: getRandomTimezone(),
  };
}

function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile Safari/604.1",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

function getRandomCountry() {
  const countries = ["US", "IN", "PK", "UK", "DE", "FR", "CA", "AU"];
  return countries[Math.floor(Math.random() * countries.length)];
}

function getRandomTimezone() {
  const zones = [
    "America/New_York",
    "Europe/London",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Europe/Berlin",
    "Asia/Dubai",
  ];
  return zones[Math.floor(Math.random() * zones.length)];
}

function getSpoofedHeaders(ip, userAgent, country, timezone) {
  return {
    "User-Agent": userAgent,
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

// ----------------- Proxy Tester -----------------
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
    logger.error(`Proxy ${proxyUrl} failed: ${err.message}`);
    return { working: false, error: err.message };
  }
}

async function getWorkingProxy() {
  if (proxies.length === 0) return null;

  for (let proxy of proxies) {
    logger.info(`Testing proxy: ${proxy}`);
    const test = await testProxy(proxy);
    if (test.working) {
      logger.info(`Proxy working: ${proxy} (IP: ${test.ip})`);
      return { url: proxy, ip: test.ip };
    }
  }

  logger.warn("No working proxy found, using direct connection");
  return null;
}

// ----------------- GA Spoofing Script -----------------
function getGASpoofScript(session, clientIp) {
  return `
<script>
  (function() {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      if (url.includes('google-analytics.com')) {
        console.log('GA beacon intercepted:', url);
        const modifiedData = new Blob([data], { type: 'application/x-www-form-urlencoded' });
        return originalSendBeacon.call(this, url, modifiedData);
      }
      return originalSendBeacon.apply(this, arguments);
    };

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (url && url.includes('google-analytics.com')) {
        console.log('GA XHR intercepted:', url);
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
</script>
`;
}

// ----------------- Routes -----------------
app.get("/", async (req, res) => {
  const clientIp = getClientIp(req);
  logger.info(`Request from ${clientIp} for ${req.url}`);

  // ✅ Create new session here
  const session = createSession();

  try {
    const proxy = await getWorkingProxy();
    let agent = null;
    let proxyIp = "direct";

    if (proxy) {
      logger.info(`Using proxy: ${proxy.url}`);
      session.proxyIp = proxy.ip;
      proxyIp = proxy.ip;
      agent = new SocksProxyAgent(proxy.url);
    }

    const fetch = (await import("node-fetch")).default;
    const spoofedHeaders = getSpoofedHeaders(
      proxyIp,
      session.userAgent,
      session.country,
      session.timezone
    );

    const fetchOptions = { timeout: 30000, headers: spoofedHeaders };
    if (agent) fetchOptions.agent = agent;

    const response = await fetch(TARGET_SITE, fetchOptions);
    let body = await response.text();

    if (response.headers.get("content-type")?.includes("text/html")) {
      const sessionScript = `
        <script>
          console.log("Served via: ${proxyIp}");
          console.log("User-Agent: ${session.userAgent}");
          console.log("Country: ${session.country}");
          console.log("Timezone: ${session.timezone}");
        </script>
      `;
      body = body.replace(
        "</body>",
        sessionScript + getGASpoofScript(session, clientIp) + "</body>"
      );
    }

    res.set("Content-Type", response.headers.get("content-type") || "text/html");
    logger.info(`Served ${TARGET_SITE} to ${clientIp} via ${proxyIp}`);
    res.send(body);
  } catch (err) {
    logger.error(`Fetch error: ${err.message}`);
    res.status(500).send(`
      <h2>Error fetching site</h2>
      <p>${err.message}</p>
    `);
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    proxies: proxies.length,
    target: TARGET_SITE,
    timestamp: new Date().toISOString(),
  });
});

// ----------------- Server -----------------
function startServer(port, host, maxAttempts = 10) {
  const portNumber = parseInt(port);

  const server = app
    .listen(portNumber, host, () => {
      logger.info(`Server running at http://${host}:${portNumber}`);
      logger.info(`Server is globally accessible at http://13.61.6.207:${portNumber}`);
      logger.info(`Proxying to: ${TARGET_SITE}`);
    })
    .on("error", (err) => {
      if (err.code === "EADDRINUSE" && maxAttempts > 0) {
        logger.info(
          `Port ${portNumber} is busy, trying port ${portNumber + 1}...`
        );
        startServer(portNumber + 1, host, maxAttempts - 1);
      } else {
        logger.error(`Server error: ${err.message}`);
        if (maxAttempts <= 0) {
          logger.error(
            "Maximum port retry attempts reached. Could not start server."
          );
        }
      }
    });

  return server;
}

startServer(PORT, HOST);
