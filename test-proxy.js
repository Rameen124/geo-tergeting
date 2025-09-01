const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");
const winston = require("winston");

// Configure logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Load proxies from proxies.txt
let proxies = [];
try {
  proxies = fs
    .readFileSync("proxies.txt", "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "")
    .map(line => {
      if (!line.startsWith("socks5://") && !line.startsWith("socks4://") && !line.startsWith("http://")) {
        return `socks5://${line}`;
      }
      return line;
    });
  
  logger.info(`Loaded ${proxies.length} proxies from proxies.txt`);
} catch (err) {
  logger.error("Error loading proxies:", err.message);
  process.exit(1);
}

// Test proxy
async function testProxy(proxyUrl) {
  try {
    const fetch = (await import('node-fetch')).default;
    const agent = new SocksProxyAgent(proxyUrl);
    
    const res = await fetch("https://api.ipify.org?format=json", {
      agent,
      timeout: 8000,
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    
    const data = await res.json();
    return { working: true, ip: data.ip };
  } catch (err) {
    return { working: false, error: err.message };
  }
}

// Test all proxies
async function testAllProxies() {
  logger.info("Testing all proxies...");
  
  const results = [];
  for (let proxy of proxies) {
    logger.info(`Testing: ${proxy}`);
    const result = await testProxy(proxy);
    results.push({ proxy, ...result });
    
    if (result.working) {
      logger.info(`✅ Working: ${proxy} (IP: ${result.ip})`);
    } else {
      logger.info(`❌ Failed: ${proxy} (Error: ${result.error})`);
    }
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const working = results.filter(r => r.working);
  logger.info(`\nResults: ${working.length}/${proxies.length} proxies working`);
  
  return results;
}

// Run tests
testAllProxies().then(results => {
  process.exit(0);
}).catch(err => {
  logger.error(`Test error: ${err.message}`);
  process.exit(1);
});
