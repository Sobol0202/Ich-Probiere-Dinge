// netlify/functions/shelly-toggle.js

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Use POST" };
  }

  const HOST = process.env.SHELLY_HOST;          // z.B. shelly-106-eu.shelly.cloud
  const AUTH_KEY = process.env.SHELLY_AUTH_KEY;  // aus der App
  const ID = process.env.SHELLY_DEVICE_ID;       // Device ID aus der App
  const CHANNEL = Number(process.env.SHELLY_CHANNEL ?? "0");

  if (!HOST || !AUTH_KEY || !ID) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Missing env vars" }),
    };
  }

  const apiBase = `https://${HOST}`;

  // 1) Status holen
  const getRes = await fetch(`${apiBase}/v2/devices/api/get?auth_key=${encodeURIComponent(AUTH_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [ID], select: ["status"] }),
  });

  if (!getRes.ok) {
    const text = await getRes.text();
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "get", status: getRes.status, body: text }),
    };
  }

  const arr = await getRes.json();
  const status = arr?.[0]?.status ?? {};
  const switchKey = `switch:${CHANNEL}`;

  // Shelly Plus 1PM: status["switch:0"].output ist typisch korrekt
  const current = status?.[switchKey]?.output;

  if (typeof current !== "boolean") {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: `Konnte status["${switchKey}"].output nicht lesen.`,
        statusKeys: Object.keys(status),
      }),
    };
  }

  const nextOn = !current;

  // 2) Schalten
  const setRes = await fetch(`${apiBase}/v2/devices/api/set/switch?auth_key=${encodeURIComponent(AUTH_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: ID, channel: CHANNEL, on: nextOn }),
  });

  if (!setRes.ok) {
    const text = await setRes.text();
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "set", status: setRes.status, body: text }),
    };
  }

  const result = await setRes.json().catch(() => ({}));

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, from: current, to: nextOn, result }),
  };
};
