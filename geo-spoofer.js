const UserAgent = require('user-agents');

// Extended country data
const countries = {
  US: { 
    timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver'],
    languages: 'en-US,en;q=0.9',
    platform: '"Windows"'
  },
  UK: { 
    timezones: ['Europe/London'],
    languages: 'en-GB,en;q=0.9',
    platform: '"Windows"'
  },
  DE: { 
    timezones: ['Europe/Berlin'],
    languages: 'de-DE,de;q=0.9,en;q=0.8',
    platform: '"Windows"'
  },
  FR: { 
    timezones: ['Europe/Paris'],
    languages: 'fr-FR,fr;q=0.9,en;q=0.8',
    platform: '"Windows"'
  },
  JP: { 
    timezones: ['Asia/Tokyo'],
    languages: 'ja-JP,ja;q=0.9,en;q=0.8',
    platform: '"Windows"'
  }
};

function getRandomTimezone(country = 'US') {
  const countryData = countries[country] || countries.US;
  return countryData.timezones[Math.floor(Math.random() * countryData.timezones.length)];
}

function getSpoofedHeaders(ip, userAgent, country, timezone) {
  const countryData = countries[country] || countries.US;
  const isMobile = userAgent.includes('Mobile');
  
  return {
    'User-Agent': userAgent,
    'X-Forwarded-For': ip,
    'X-Real-IP': ip,
    'Accept-Language': countryData.languages,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'TE': 'trailers',
    'CF-IPCountry': country,
    'X-Timezone': timezone,
    'Sec-CH-UA-Platform': countryData.platform,
    'Sec-CH-UA-Mobile': isMobile ? '?1' : '?0'
  };
}

module.exports = { getSpoofedHeaders, getRandomTimezone };
