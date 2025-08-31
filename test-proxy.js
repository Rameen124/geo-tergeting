// test-proxy.js
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');

async function testProxy() {
  const proxyUrl = 'socks5://razajee6626-zone-custom-region-US:razajee6626@na.proxys5.net:6200';
  console.log(`Testing proxy: ${proxyUrl}`);
  
  try {
    const agent = new SocksProxyAgent(proxyUrl);
    const response = await fetch('https://httpbin.org/ip', { 
      agent, 
      timeout: 10000 
    });
    const data = await response.json();
    console.log('✅ Proxy working, IP:', data.origin);
    
    // Test with Google
    const googleResponse = await fetch('https://www.google.com', { 
      agent, 
      timeout: 10000 
    });
    console.log('✅ Google response status:', googleResponse.status);
  } catch (error) {
    console.error('❌ Proxy test failed:', error.message);
  }
}

testProxy();
