const express = require("express");
const { SocksProxyAgent } = require("socks-proxy-agent");
const fetch = require("node-fetch");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
// Use any available port, starting from 3000
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces
const TARGET_SITE = "https://havali.xyz";

// Load proxies from proxies.txt
let proxies = [];
try {
  proxies = fs
    .readFileSync("proxies.txt", "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  console.log(`✅ Loaded ${proxies.length} proxies`);
} catch (err) {
  console.error("⚠️ Error loading proxies.txt:", err.message);
}

// Utility → get client IP
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    "unknown"
  );
}

// Create session with random values
function createSession() {
  return {
    id: uuidv4(),
    proxyIp: null,
    userAgent: getRandomUserAgent(),
    country: getRandomCountry(),
    timezone: getRandomTimezone(),
  };
}

// Random User-Agent
function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile Safari/604.1",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

// Random country
function getRandomCountry() {
  const countries = ["US", "IN", "PK", "UK", "DE", "FR", "CA", "AU"];
  return countries[Math.floor(Math.random() * countries.length)];
}

// Random timezone
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

// Generate spoofed headers
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
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// Test proxy
async function testProxy(proxyUrl) {
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const res = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 8000,
    });
    const data = await res.json();
    return { working: true, ip: data.ip };
  } catch (err) {
    return { working: false };
  }
}

// Pick working proxy
async function getTestedProxy() {
  for (let proxy of proxies) {
    const test = await testProxy(proxy);
    if (test.working) {
      return proxy;
    }
  }
  throw new Error("No working proxy found");
}

// Root endpoint → serve havali.xyz via proxy
app.get("/", async (req, res) => {
  const clientIp = getClientIp(req);
  console.log(`👤 Visitor from IP: ${clientIp}`);

  const session = createSession();
  try {
    const proxyUrl = await getTestedProxy();
    console.log(`🌀 Using Proxy: ${proxyUrl}`);

    const proxyTest = await testProxy(proxyUrl);
    if (!proxyTest.working) {
      return res
        .status(500)
        .send("<h2>No working proxy available right now.</h2>");
    }

    session.proxyIp = proxyTest.ip;
    const agent = new SocksProxyAgent(proxyUrl);

    const spoofedHeaders = getSpoofedHeaders(
      proxyTest.ip,
      session.userAgent,
      session.country,
      session.timezone
    );

    const response = await fetch(TARGET_SITE, {
      agent,
      timeout: 30000,
      headers: spoofedHeaders,
    });

    let body = await response.text();

    // inject debug info
    if (response.headers.get("content-type")?.includes("text/html")) {
      const sessionScript = `
        <script>
          console.log("🔗 Served via proxy: ${session.proxyIp}");
          console.log("🕵️ User-Agent: ${session.userAgent}");
        </script>
      `;
      body = body.replace("</body>", sessionScript + "</body>");
    }

    res.set(
      "Content-Type",
      response.headers.get("content-type") || "text/html"
    );

    console.log(
      `✅ Served havali.xyz to ${clientIp} via proxy ${session.proxyIp}`
    );
    res.send(body);
  } catch (err) {
    console.error("❌ Proxy fetch error:", err.message);
    res.status(500).send("<h2>Error fetching site through proxy.</h2>");
  }
});

// Function to start server with port retry logic
function startServer(port, host) {
  const server = app.listen(port, host, () => {
    console.log(`🚀 Server running at http://${host}:${port}`);
    console.log(`🌍 Server is globally accessible at http://13.61.6.207:${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️ Port ${port} is busy, trying port ${port + 1}...`);
      startServer(port + 1, host);
    } else {
      console.error('❌ Server error:', err);
    }
  });
  
  return server;
}

// Start server with retry logic
startServer(PORT, HOST);
