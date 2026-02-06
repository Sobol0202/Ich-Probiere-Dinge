let lastCallTs = 0; // best-effort throttle pro Function-Container

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { res, body };
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "Use POST" };

  // --- simple throttle: max 1 call / 800ms pro warm container ---
  const now = Date.now();
  if (now - lastCallTs < 800) {
    return {
      statusCode: 429,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Please wait a moment and try again." }),
    };
  }
  lastCallTs = now;

  const HOST = process.env.SHELLY_HOST;
  const AUTH_KEY = process.env.SHELLY_AUTH_KEY;
  const DEVICE_ID = process.env.SHELLY_DEVICE_ID;
  const CHANNEL = Number(process.env.SHELLY_CHANNEL ?? "0");

  if (!HOST || !AUTH_KEY || !DEVICE_ID) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Missing env vars" }),
    };
  }

  const apiBase = `https://${HOST}`;

  // 1) GET status
  let device;
  try {
    const { res, body } = await fetchJson(
      `${apiBase}/v2/devices/api/get?auth_key=${encodeURIComponent(AUTH_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [DEVICE_ID], select: ["status"] }),
      }
    );

    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, step: "get_http", status: res.status, body }),
      };
    }

    if (!Array.isArray(body) || !body[0]) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "No device state returned", body }),
      };
    }

    device = body[0];
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "get_fetch", error: String(e) }),
    };
  }

  const status = device.status ?? {};
  const switchKey = `switch:${CHANNEL}`;
  const current = status?.[switchKey]?.output;

  if (typeof current !== "boolean") {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: `Cannot read status["${switchKey}"].output`,
        statusKeys: Object.keys(status),
        switchObj: status?.[switchKey] ?? null,
      }),
    };
  }

  const nextOn = !current;

  // 2) SET with retry on 429
  const setUrl = `${apiBase}/v2/devices/api/set/switch?auth_key=${encodeURIComponent(AUTH_KEY)}`;
  const payload = { id: DEVICE_ID, channel: CHANNEL, on: nextOn };

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { res, body } = await fetchJson(setUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        // Backoff: 400ms, 800ms, 1600ms...
        const wait = 400 * Math.pow(2, attempt - 1);
        if (attempt === maxAttempts) {
          return {
            statusCode: 429,
            headers: { ...cors, "Content-Type": "application/json" },
            body: JSON.stringify({
              ok: false,
              step: "set_http",
              status: 429,
              error: "Rate limited by Shelly Cloud. Try again in a few seconds.",
              body,
            }),
          };
        }
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        return {
          statusCode: 502,
          headers: { ...cors, "Content-Type": "application/json" },
          body: JSON.stringify({ ok: false, step: "set_http", status: res.status, body }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, from: current, to: nextOn, result: body }),
      };
    } catch (e) {
      if (attempt === maxAttempts) {
        return {
          statusCode: 502,
          headers: { ...cors, "Content-Type": "application/json" },
          body: JSON.stringify({ ok: false, step: "set_fetch", error: String(e) }),
        };
      }
      await sleep(300 * attempt);
    }
  }
};
