const { createProxyMiddleware } = require("http-proxy-middleware");

const PRIMARY_TARGET = process.env.API_PROXY_PRIMARY || "http://localhost:8060";
const SECONDARY_TARGET = process.env.API_PROXY_SECONDARY || "http://localhost:8061";
const PROXY_PATHS = ["/api", "/geoserver"];

const isRetryableProxyError = (err) =>
  ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].includes(err?.code);

const createTargetProxy = (target, onError) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: false,
    secure: false,
    logLevel: "warn",
    onError,
  });

module.exports = function setupProxy(app) {
  const sendBadGateway = (res, err) => {
    if (!res || res.headersSent || typeof res.writeHead !== "function" || typeof res.end !== "function") {
      if (typeof res?.destroy === "function") res.destroy();
      return;
    }

    const body = JSON.stringify({
      success: false,
      message: "Backend is unreachable on both configured proxy ports.",
      targetsTried: [PRIMARY_TARGET, SECONDARY_TARGET],
      error: err?.code || "PROXY_ERROR",
    });

    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(body);
  };

  const secondaryProxy = createTargetProxy(SECONDARY_TARGET, (err, req, res) => {
    console.error(`[proxy] Secondary target failed: ${SECONDARY_TARGET}`, err?.code || err?.message);
    sendBadGateway(res, err);
  });

  const primaryProxy = createTargetProxy(PRIMARY_TARGET, (err, req, res) => {
    if (isRetryableProxyError(err) && !req.__proxyRetried) {
      req.__proxyRetried = true;
      console.warn(
        `[proxy] Primary target failed (${PRIMARY_TARGET}, ${err?.code || err?.message}). Retrying ${SECONDARY_TARGET}`
      );
      return secondaryProxy(req, res, req.__proxyNext || (() => {}));
    }

    console.error(`[proxy] Primary target failed: ${PRIMARY_TARGET}`, err?.code || err?.message);
    sendBadGateway(res, err);
  });

  app.use((req, res, next) => {
    if (!PROXY_PATHS.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }

    req.__proxyNext = next;
    return primaryProxy(req, res, next);
  });
};