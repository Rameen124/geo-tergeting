// geo-spoofer.js
const countries = {
  US: { timezone: 'America/New_York', ipPrefix: '73.' },
  UK: { timezone: 'Europe/London', ipPrefix: '51.' },
};

function getRandomTimezone(country = 'US') {
  return countries[country]?.timezone || 'UTC';
}

function getSpoofedHeaders(ip, userAgent, country, timezone) {
  return {
    'User-Agent': userAgent,
    'X-Forwarded-For': ip,
    'X-Real-IP': ip,
    'Accept-Language': country === 'US' ? 'en-US,en;q=0.9' : 'en-GB,en;q=0.9',
    'CF-IPCountry': country,
    'X-Timezone': timezone,
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-CH-UA-Mobile': '?0',
  };
}

module.exports = { getSpoofedHeaders, getRandomTimezone };
