const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const hardware = require("./hardware");
const { app } = require("electron");

let server = null;

/**
 * Initializes the admin web server.
 *
 * @returns {bool} Returns true if the initialization was successful.
 */
const init = async () => {
  const port = parseInt(ARGS.admin_port) || 33333;

  server = http.createServer(handleRequest);
  server.listen(port, "0.0.0.0", () => {
    const addresses = hardware.getNetworkAddresses();
    const ips = Object.values(addresses)
      .flatMap((f) => Object.values(f))
      .flat()
      .filter((ip) => !ip.includes(":"));
    const urls = ips.map((ip) => `http://${ip}:${port}`);
    console.info(`Admin UI: ${urls.join(", ") || `http://0.0.0.0:${port}`}`);
  });

  server.on("error", (err) => {
    console.error("Admin server error:", err.message);
  });

  return true;
};

/**
 * Handles incoming HTTP requests.
 *
 * @param {http.IncomingMessage} req - The request object.
 * @param {http.ServerResponse} res - The response object.
 */
const handleRequest = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for local access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      return serveFile(res, path.join(app.getAppPath(), "html", "admin", "index.html"), "text/html");
    }
    if (pathname === "/api/config" && req.method === "GET") {
      return getConfig(req, res);
    }
    if (pathname === "/api/config" && req.method === "POST") {
      return setConfig(req, res);
    }
    if (pathname === "/api/screenshot") {
      return getScreenshot(req, res);
    }
    if (pathname === "/api/status") {
      return getStatus(req, res);
    }
    if (pathname === "/api/logs") {
      return getLogs(req, res);
    }
    if (pathname === "/api/restart") {
      return postRestart(req, res);
    }

    // Static files from html/admin/
    if (pathname.startsWith("/static/")) {
      const safePath = pathname.replace(/\.\./g, "").replace(/^\/static\//, "");
      return serveFile(res, path.join(app.getAppPath(), "html", "admin", safePath));
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (error) {
    console.error("Admin request error:", error.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
};

/**
 * Serves a static file.
 *
 * @param {http.ServerResponse} res - The response object.
 * @param {string} filePath - Absolute file path.
 * @param {string} [contentType] - Optional MIME type override.
 */
const serveFile = (res, filePath, contentType) => {
  // Validate the file path is within the app directory
  const resolved = path.resolve(filePath);
  const appPath = path.resolve(app.getAppPath());
  if (!resolved.startsWith(appPath)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Forbidden" }));
  }

  if (!fs.existsSync(resolved)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not Found" }));
  }

  const mimeTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  const ext = path.extname(resolved);
  const mime = contentType || mimeTypes[ext] || "application/octet-stream";
  const content = fs.readFileSync(resolved);

  res.writeHead(200, { "Content-Type": mime });
  res.end(content);
};

/**
 * Returns the current configuration (with password masked).
 */
const getConfig = (req, res) => {
  const config = Object.assign({}, ARGS);
  // Convert web_url array back to comma-separated for the UI
  if (Array.isArray(config.web_url)) {
    config.web_url = config.web_url.join(", ");
  }
  // Mask password
  if ("mqtt_password" in config) {
    config.mqtt_password = "*".repeat((config.mqtt_password || "").length);
  }
  // Remove transient flags
  delete config.app_reset;
  delete config.help;
  delete config.version;
  delete config.setup;

  config._version = APP.version;

  json(res, 200, config);
};

/**
 * Updates and saves the configuration.
 */
const setConfig = (req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    // Limit body size to 64KB
    if (body.length + chunk.length > 65536) {
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);
      const newArgs = {};

      // Validate and map fields
      const stringFields = [
        "web_url",
        "web_theme",
        "web_zoom",
        "web_widget",
        "web_screensaver",
        "mqtt_url",
        "mqtt_user",
        "mqtt_password",
        "mqtt_discovery",
        "admin_port",
      ];
      const intervalFields = [
        "app_heartbeat_interval",
        "app_sensor_interval",
        "app_upgrade_interval",
        "app_screenshot_interval",
        "app_release_interval",
      ];
      const booleanFields = ["app_debug", "app_early", "enable_logging", "ignore_certificate_errors"];

      for (const key of stringFields) {
        if (key in data && data[key] !== undefined && data[key] !== "") {
          newArgs[key] = String(data[key]).trim();
        }
      }
      for (const key of intervalFields) {
        if (key in data && data[key] !== undefined && data[key] !== "") {
          const val = parseInt(data[key]);
          if (!isNaN(val) && val > 0) {
            newArgs[key] = String(val);
          }
        }
      }
      for (const key of booleanFields) {
        if (data[key] === true || data[key] === "true") {
          newArgs[key] = null;
        }
      }

      // Handle web_url: split comma-separated
      if (newArgs.web_url) {
        newArgs.web_url = newArgs.web_url
          .split(",")
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
      }

      // Handle password: keep existing if masked
      if (newArgs.mqtt_password && /^\*+$/.test(newArgs.mqtt_password)) {
        if (ARGS.mqtt_password) {
          newArgs.mqtt_password = ARGS.mqtt_password;
        } else {
          delete newArgs.mqtt_password;
        }
      }

      // Validate required fields
      if (!newArgs.web_url || newArgs.web_url.length === 0) {
        return json(res, 400, { error: "web_url is required" });
      }
      if (newArgs.web_url.some((url) => !/^https?:\/\//.test(url))) {
        return json(res, 400, { error: "web_url must start with http(s)://" });
      }
      if (newArgs.mqtt_url && !/^(mqtts?|wss?):\/\//.test(newArgs.mqtt_url)) {
        return json(res, 400, { error: "mqtt_url must start with mqtt(s):// or ws(s)://" });
      }

      // Save to file
      const argsFilePath = path.join(APP.config, "Arguments.json");
      const argsToSave = Object.assign({}, newArgs);
      if ("mqtt_password" in argsToSave && argsToSave.mqtt_password) {
        const iv = crypto.randomBytes(12);
        const key = crypto.scryptSync(hardware.getMachineId(), APP.name, 32);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        let encrypted = cipher.update(argsToSave.mqtt_password, "utf8", "hex");
        encrypted += cipher.final("hex");
        const authTag = cipher.getAuthTag().toString("hex");
        argsToSave.mqtt_password = Buffer.from(iv.toString("hex") + ":" + authTag + ":" + encrypted).toString("base64");
      }
      fs.writeFileSync(argsFilePath, JSON.stringify(argsToSave, null, 2));

      json(res, 200, { success: true, message: "Configuration saved. Restart required to apply changes." });
    } catch (error) {
      json(res, 400, { error: "Invalid JSON: " + error.message });
    }
  });
};

/**
 * Returns the current screenshot as a PNG image.
 */
const getScreenshot = (req, res) => {
  const screenshot = WEBVIEW?.tracker?.screenshot;
  if (!screenshot) {
    res.writeHead(204);
    return res.end();
  }

  const buffer = Buffer.from(screenshot, "base64");
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": buffer.length,
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(buffer);
};

/**
 * Returns system status information.
 */
const getStatus = (req, res) => {
  const status = {
    app: {
      name: APP.title,
      version: APP.version,
      build: APP.build || {},
      uptime: Math.floor(process.uptime()),
    },
    webview: {
      initialized: WEBVIEW?.initialized || false,
      urls: WEBVIEW?.viewUrls?.slice(1) || [],
      activeView: WEBVIEW?.viewActive || 0,
      display: WEBVIEW?.display || {},
      theme: WEBVIEW?.theme?.get?.() || null,
      zoom: WEBVIEW?.zoom?.get?.() || null,
      window: WEBVIEW?.tracker?.window?.status || null,
      screensaver: WEBVIEW?.tracker?.screensaver || false,
    },
    hardware: {
      initialized: HARDWARE?.initialized || false,
      support: HARDWARE?.support || {},
      session: HARDWARE?.session || {},
      battery: HARDWARE?.support?.batteryLevel ? hardware.getBatteryLevel() : null,
      brightness: HARDWARE?.support?.displayBrightness ? hardware.getDisplayBrightness() : null,
      volume: HARDWARE?.support?.audioVolume ? hardware.getAudioVolume() : null,
      display: HARDWARE?.support?.displayStatus ? hardware.getDisplayStatus() : null,
    },
    integration: {
      initialized: INTEGRATION?.initialized || false,
      node: INTEGRATION?.node || null,
      connected: INTEGRATION?.client?.connected || false,
    },
    network: hardware.getNetworkAddresses(),
  };

  json(res, 200, status);
};

/**
 * Returns recent log entries.
 */
const getLogs = (req, res) => {
  json(res, 200, APP.logs || []);
};

/**
 * Triggers an app restart.
 */
const postRestart = (req, res) => {
  json(res, 200, { success: true, message: "Restarting..." });
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
};

/**
 * Sends a JSON response.
 *
 * @param {http.ServerResponse} res - The response object.
 * @param {number} statusCode - HTTP status code.
 * @param {Object} data - The data to send.
 */
const json = (res, statusCode, data) => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

/**
 * Returns the admin server port.
 *
 * @returns {number} The port number.
 */
const getPort = () => {
  return parseInt(ARGS.admin_port) || 33333;
};

/**
 * Returns the admin URL for the first non-loopback IPv4 address.
 *
 * @returns {string|null} The admin URL.
 */
const getUrl = () => {
  const addresses = hardware.getNetworkAddresses();
  const ip = Object.values(addresses)
    .flatMap((f) => Object.values(f))
    .flat()
    .find((ip) => !ip.includes(":"));
  return ip ? `http://${ip}:${getPort()}` : null;
};

/**
 * Stops the admin server.
 */
const stop = () => {
  if (server) {
    server.close();
    server = null;
  }
};

module.exports = {
  init,
  stop,
  getPort,
  getUrl,
};
