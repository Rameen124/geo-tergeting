const { SocksProxyAgent } = require("socks-proxy-agent");
const fs = require("fs");

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

// Load proxies from proxies.txt
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
        // Remove any duplicate protocol prefixes
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
    logWarn("proxies.txt not found.");
    process.exit(1);
  }
} catch (err) {
  logError(`Proxy load failed: ${err.message}`);
  process.exit(1);
}

// Test proxy
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

// Test all proxies
async function testAllProxies() {
  logInfo("Testing all proxies...");
  
  const results = [];
  let workingCount = 0;
  
  for (let proxy of proxies) {
    logInfo(`Testing: ${proxy}`);
    const result = await testProxy(proxy);
    results.push({ proxy, ...result });
    
    if (result.working) {
      logInfo(`✅ Working: ${proxy} (IP: ${result.ip})`);
      workingCount++;
    } else {
      logInfo(`❌ Failed: ${proxy}`);
    }
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  logInfo(`\nResults: ${workingCount}/${proxies.length} proxies working`);
  
  // Display working proxies
  if (workingCount > 0) {
    logInfo("\nWorking proxies:");
    results.filter(r => r.working).forEach(r => {
      logInfo(`- ${r.proxy} (IP: ${r.ip})`);
    });
  }
  
  return results;
}

// Run tests
testAllProxies().then(results => {
  process.exit(0);
}).catch(err => {
  logError(`Test error: ${err.message}`);
  process.exit(1);
});
