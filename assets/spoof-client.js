(function () {
  "use strict";

  const sessionData = window.SESSION_DATA || {};

  // ---------------- GA interception ----------------
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;
  const originalSendBeacon = navigator.sendBeacon;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._requestUrl = url;
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._requestUrl;
    if (url && isGoogleAnalytics(url)) {
      proxyRequest(getGAEndpoint(url), body).catch(() => {});
      return;
    }
    originalXHRSend.call(this, body);
  };

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    if (isGoogleAnalytics(url)) {
      return proxyRequest(getGAEndpoint(url), init?.body).then(
        () => new Response(null, { status: 204 }),
        () => new Response(null, { status: 500 })
      );
    }
    return originalFetch(input, init);
  };

  navigator.sendBeacon = function (url, data) {
    if (isGoogleAnalytics(url)) {
      proxyRequest(getGAEndpoint(url), data).catch(() => {});
      return true;
    }
    return originalSendBeacon(url, data);
  };

  function isGoogleAnalytics(url) {
    return (
      url &&
      (url.includes("google-analytics.com") ||
        url.includes("analytics.google.com") ||
        url.includes("googletagmanager.com/gtag/js") ||
        url.includes("www.google-analytics.com/collect"))
    );
  }

  function getGAEndpoint(fullUrl) {
    try {
      const u = new URL(fullUrl);
      return u.pathname + u.search;
    } catch {
      return "/g/collect";
    }
  }

  async function proxyRequest(endpoint, body) {
    const formData = new URLSearchParams();
    if (body && typeof body === "string") {
      body.split("&").forEach((p) => {
        const [k, v] = p.split("=");
        if (k && v) formData.append(decodeURIComponent(k), decodeURIComponent(v));
      });
    }
    return fetch("/ga-proxy?session_id=" + encodeURIComponent(sessionData.id) + "&ga_endpoint=" + encodeURIComponent(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });
  }

  // ---------- Geolocation spoof ----------
  if (navigator.geolocation) {
    const spoofedCoords =
      sessionData.country === "US"
        ? { latitude: 40.7128, longitude: -74.006 }
        : { latitude: 51.5074, longitude: -0.1278 };
    const spoofedPosition = { coords: { ...spoofedCoords, accuracy: 50 }, timestamp: Date.now() };

    navigator.geolocation.getCurrentPosition = (cb) => cb(spoofedPosition);
    navigator.geolocation.watchPosition = (cb) => {
      cb(spoofedPosition);
      return 1;
    };
  }

  console.log("✅ Client spoof active:", sessionData);
})();
