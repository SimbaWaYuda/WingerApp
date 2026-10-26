const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const host = "127.0.0.1";
const port = Number(process.env.PUBLIC_ORIGIN_PORT || 8088);
const webRoot = path.resolve(
  process.argv[2] || path.join(__dirname, "..", "apps", "winger", "build", "web"),
);
const webOrigin = process.env.WINGER_WEB_ORIGIN || "http://127.0.0.1:61259";
const apiOrigin = process.env.WINGER_API_ORIGIN || "http://127.0.0.1:3000";

const apiPrefixes = [
  "/health",
  "/auth",
  "/products",
  "/orders",
  "/payments",
  "/suppliers",
  "/analytics",
  "/commissions",
  "/onboarding",
  "/notifications",
  "/sync",
  "/reviews",
  "/fx",
  "/stripe",
  "/uploads",
];

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".bin": "application/octet-stream",
};

function isApiPath(urlPath) {
  return apiPrefixes.some(
    (prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`),
  );
}

function proxy(req, res, target) {
  const incoming = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const dest = new URL(incoming.pathname + incoming.search, target);
  const headers = { ...req.headers, host: dest.host };
  const proxyReq = http.request(
    dest,
    { method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Cache-Control": "no-store" });
    }
    res.end("origin offline");
  });
  req.pipe(proxyReq);
}

function serveWebFile(req, res, urlPath) {
  let filePath = urlPath;
  if (filePath.endsWith("/")) filePath += "index.html";
  if (filePath === "") filePath = "/index.html";
  const file = path.normalize(path.join(webRoot, filePath));
  if (!file.startsWith(path.normalize(webRoot))) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Flutter hash routes all live on index.html.
      fs.readFile(path.join(webRoot, "index.html"), (indexErr, indexData) => {
        if (indexErr) {
          proxy(req, res, webOrigin);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(indexData);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    let urlPath = "/";
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch (_) {
      urlPath = "/";
    }
    if (isApiPath(urlPath)) {
      proxy(req, res, apiOrigin);
      return;
    }
    serveWebFile(req, res, urlPath);
  })
  .listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Winger public origin http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`Shop files ${webRoot}`);
    // eslint-disable-next-line no-console
    console.log(`API ${apiOrigin}`);
  });
