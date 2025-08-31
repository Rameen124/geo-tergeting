(function() {
  const sessionData = window.SESSION_DATA || {};

  // ---------- Geolocation Spoof ----------
  if (navigator.geolocation) {
    const spoofedCoords = {
      latitude: sessionData.country === 'US' ? 40.7128 : 51.5074,
      longitude: sessionData.country === 'US' ? -74.0060 : -0.1278,
      accuracy: 50,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    };

    const spoofedPosition = { coords: spoofedCoords, timestamp: Date.now() };

    navigator.geolocation.getCurrentPosition = function(success, error) {
      if (typeof success === 'function') success(spoofedPosition);
      else if (typeof error === 'function') error({ code: 1, message: 'Geolocation blocked' });
    };

    navigator.geolocation.watchPosition = function(success, error) {
      if (typeof success === 'function') success(spoofedPosition);
      return 1; // fake watch ID
    };
  }

  // ---------- Timezone Spoof ----------
  if (sessionData.timezone) {
    const originalDateToString = Date.prototype.toString;
    const timezoneOffsets = {
      'America/New_York': -5 * 60,
      'Europe/London': 0
    };
    const offset = timezoneOffsets[sessionData.timezone] || 0;

    Date.prototype.toString = function() {
      const adjusted = new Date(this.getTime() + offset * 60000);
      return originalDateToString.call(adjusted);
    };

    // Also override getTimezoneOffset
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return -offset; // JS uses negative for west of GMT
    };
  }

  // ---------- Language Spoof ----------
  Object.defineProperty(navigator, 'language', { get: () => sessionData.country === 'US' ? 'en-US' : 'en-GB' });
  Object.defineProperty(navigator, 'languages', { get: () => sessionData.country === 'US' ? ['en-US','en'] : ['en-GB','en'] });

  // ---------- Screen Properties ----------
  Object.defineProperty(window.screen, 'width', { get: () => 1920 });
  Object.defineProperty(window.screen, 'height', { get: () => 1080 });
  Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });

  // ---------- Block WebRTC ----------
  if (window.RTCPeerConnection) {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = function(config) {
      if (config && config.iceServers) config.iceServers = [];
      const pc = new OriginalRTCPeerConnection(config);
      // Override localDescription to hide local IPs
      const originalSetLocalDescription = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = function(desc) {
        if (desc && desc.sdp) {
          desc.sdp = desc.sdp.replace(/a=candidate:.+\r\n/g, ''); // remove ICE candidates
        }
        return originalSetLocalDescription(desc);
      };
      return pc;
    };
  }

  // ---------- Console Logs ----------
  console.log('✅ Client-side spoofing active for session:', sessionData.id);
  console.log('✅ Using proxy IP:', sessionData.proxyIp);
  console.log('✅ Spoofed country/timezone:', sessionData.country, sessionData.timezone);
})();
