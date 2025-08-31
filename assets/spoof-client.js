(function() {
    'use strict';
    
    const sessionData = window.SESSION_DATA || {};
    
    // Store original methods
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalFetch = window.fetch;
    const originalSendBeacon = navigator.sendBeacon;
    
    // Override XMLHttpRequest.open to capture URL
    XMLHttpRequest.prototype.open = function(method, url) {
        this._requestUrl = url;
        return originalXHROpen.apply(this, arguments);
    };
    
    // Override XMLHttpRequest.send
    XMLHttpRequest.prototype.send = function(body) {
        const url = this._requestUrl;
        if (url && isGoogleAnalytics(url)) {
            const gaEndpoint = getGAEndpoint(url);
            proxyRequest(gaEndpoint, body, this)
                .then(() => {
                    // Simulate success
                    if (typeof this.onload === 'function') {
                        this.onload.call(this, new Event('load'));
                    }
                })
                .catch(() => {
                    // Simulate error
                    if (typeof this.onerror === 'function') {
                        this.onerror.call(this, new Event('error'));
                    }
                });
            return;
        }
        originalXHRSend.call(this, body);
    };
    
    // Override fetch
    window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (isGoogleAnalytics(url)) {
            const gaEndpoint = getGAEndpoint(url);
            return proxyRequest(gaEndpoint, init && init.body, null)
                .then(() => new Response(null, { status: 204, statusText: 'No Content' }))
                .catch(() => new Response(null, { status: 500, statusText: 'Internal Server Error' }));
        }
        return originalFetch(input, init);
    };
    
    // Override sendBeacon
    navigator.sendBeacon = function(url, data) {
        if (isGoogleAnalytics(url)) {
            const gaEndpoint = getGAEndpoint(url);
            proxyRequest(gaEndpoint, data, null).catch(() => {});
            return true;
        }
        return originalSendBeacon(url, data);
    };
    
    function isGoogleAnalytics(url) {
        return url && (url.includes('google-analytics.com') || 
                       url.includes('analytics.google.com') ||
                       url.includes('googletagmanager.com/gtag/js') ||
                       url.includes('www.google-analytics.com/collect'));
    }
    
    function getGAEndpoint(fullUrl) {
        try {
            const urlObj = new URL(fullUrl);
            return urlObj.pathname + urlObj.search;
        } catch (e) {
            return '/g/collect';
        }
    }
    
    async function proxyRequest(endpoint, body, xhr) {
        const formData = new URLSearchParams();
        
        if (body) {
            if (typeof body === 'string') {
                body.split('&').forEach(part => {
                    const [key, value] = part.split('=');
                    if (key && value) {
                        formData.append(decodeURIComponent(key), decodeURIComponent(value));
                    }
                });
            } else if (body instanceof FormData) {
                for (const [key, value] of body.entries()) {
                    formData.append(key, value);
                }
            } else if (body instanceof URLSearchParams) {
                for (const [key, value] of body.entries()) {
                    formData.append(key, value);
                }
            }
        }
        
        try {
            await fetch('/ga-proxy?session_id=' + encodeURIComponent(sessionData.id) + 
                       '&ga_endpoint=' + encodeURIComponent(endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: formData
            });
        } catch (error) {
            console.error('Failed to proxy GA request:', error);
            throw error;
        }
    }
    
    // ---------- Geolocation Spoofing ----------
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
        
        const spoofedPosition = { 
            coords: spoofedCoords, 
            timestamp: Date.now() 
        };
        
        navigator.geolocation.getCurrentPosition = function(success, error, options) {
            if (typeof success === 'function') {
                success(spoofedPosition);
            } else if (typeof error === 'function') {
                error({ code: 1, message: 'Geolocation blocked' });
            }
        };
        
        navigator.geolocation.watchPosition = function(success, error, options) {
            if (typeof success === 'function') {
                success(spoofedPosition);
            }
            return 1; // Return a watch ID
        };
    }
    
    // ---------- Timezone Spoofing ----------
    if (sessionData.timezone) {
        const originalToString = Date.prototype.toString;
        const timezoneOffsets = {
            'America/New_York': -5 * 60,
            'America/Chicago': -6 * 60,
            'America/Denver': -7 * 60,
            'America/Los_Angeles': -8 * 60,
            'Europe/London': 0,
            'Europe/Berlin': 1 * 60,
            'Europe/Paris': 1 * 60,
            'Asia/Tokyo': 9 * 60
        };
        
        const offset = timezoneOffsets[sessionData.timezone] || 0;
        
        Date.prototype.toString = function() {
            const adjustedDate = new Date(this.getTime() + offset * 60000);
            return originalToString.call(adjustedDate);
        };
        
        const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function() {
            return -offset;
        };
    }
    
    // ---------- Language Spoofing ----------
    Object.defineProperty(navigator, 'language', {
        get: function() { 
            return sessionData.country === 'US' ? 'en-US' : 
                   sessionData.country === 'UK' ? 'en-GB' : 
                   sessionData.country === 'DE' ? 'de-DE' :
                   sessionData.country === 'FR' ? 'fr-FR' :
                   sessionData.country === 'JP' ? 'ja-JP' : 'en-US';
        }
    });
    
    Object.defineProperty(navigator, 'languages', {
        get: function() { 
            return sessionData.country === 'US' ? ['en-US', 'en'] : 
                   sessionData.country === 'UK' ? ['en-GB', 'en'] : 
                   sessionData.country === 'DE' ? ['de-DE', 'de', 'en'] :
                   sessionData.country === 'FR' ? ['fr-FR', 'fr', 'en'] :
                   sessionData.country === 'JP' ? ['ja-JP', 'ja', 'en'] : ['en-US', 'en'];
        }
    });
    
    // ---------- Screen Properties ----------
    Object.defineProperty(window.screen, 'width', {
        get: function() { return 1920; }
    });
    
    Object.defineProperty(window.screen, 'height', {
        get: function() { return 1080; }
    });
    
    Object.defineProperty(window.screen, 'colorDepth', {
        get: function() { return 24; }
    });
    
    Object.defineProperty(window.screen, 'pixelDepth', {
        get: function() { return 24; }
    });
    
    // ---------- WebRTC Blocking ----------
    if (window.RTCPeerConnection) {
        const OriginalRTCPeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function(config) {
            if (config && config.iceServers) {
                config.iceServers = config.iceServers.filter(server => 
                    server.urls && !server.urls.some(url => url.includes('stun:') || url.includes('turn:'))
                );
            }
            return new OriginalRTCPeerConnection(config);
        };
        
        // Override getStats to hide real IPs
        const originalGetStats = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = function() {
            return originalGetStats.apply(this, arguments).then(stats => {
                const filteredStats = new Map();
                stats.forEach(report => {
                    if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                        // Filter out candidate details
                        const filteredReport = { ...report };
                        if (filteredReport.ip) filteredReport.ip = '0.0.0.0';
                        if (filteredReport.address) filteredReport.address = '0.0.0.0';
                        if (filteredReport.relatedAddress) filteredReport.relatedAddress = '0.0.0.0';
                        filteredStats.set(report.id, filteredReport);
                    } else {
                        filteredStats.set(report.id, report);
                    }
                });
                return filteredStats;
            });
        };
    }
    
    console.log('✅ Client-side spoofing active for session:', sessionData.id);
    console.log('✅ Using proxy IP:', sessionData.proxyIp);
    console.log('✅ Spoofed country/timezone:', sessionData.country, sessionData.timezone);
})();
