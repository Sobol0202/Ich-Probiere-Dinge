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

  const HOST = process.env.SHELLY_HOST;          // z.B. shelly-106-eu.shelly.cloud (OHNE :6022 /jrpc)
  const AUTH_KEY = process.env.SHELLY_AUTH_KEY;  // aus Shelly App
  const DEVICE_ID = process.env.SHELLY_DEVICE_ID;
  const CHANNEL = Number(process.env.SHELLY_CHANNEL ?? "0");

  if (!HOST || !AUTH_KEY || !DEVICE_ID) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "Missing env vars",
        need: ["SHELLY_HOST", "SHELLY_AUTH_KEY", "SHELLY_DEVICE_ID"],
      }),
    };
  }

  const apiBase = `https://${HOST}`;

  // 0) Connectivity probe (nur um Host/DNS/TLS zu validieren)
  try {
    await fetch(apiBase, { method: "GET" });
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "probe", apiBase, error: String(e) }),
    };
  }

  // 1) Status holen
  let deviceList;
  try {
    const getRes = await fetch(
      `${apiBase}/v2/devices/api/get?auth_key=${encodeURIComponent(AUTH_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // KEIN pick -> dann sollte "status" vollständig kommen (wenn verfügbar)
        body: JSON.stringify({ ids: [DEVICE_ID], select: ["status"] }),
      }
    );

    const text = await getRes.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!getRes.ok) {
      return {
        statusCode: 502,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          step: "get_http",
          status: getRes.status,
          body: json,
        }),
      };
    }

    deviceList = json;
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "get_fetch", error: String(e) }),
    };
  }

  // 2) Response validieren
  if (!Array.isArray(deviceList) || deviceList.length === 0) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "No device state returned. DEVICE_ID falsch oder nicht in deinem Account?",
        deviceList,
      }),
    };
  }

  const device = deviceList[0];

  // hilfreich fürs Debugging
  const online = device?.online;

  if (!device?.status || typeof device.status !== "object") {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "Device returned without status object (device offline oder API liefert keinen Status).",
        online,
        deviceMeta: {
          id: device?.id,
          gen: device?.gen,
          type: device?.type,
          code: device?.code,
        },
        // Wichtig: damit du siehst, was wirklich kommt
        device,
      }),
    };
  }

  const status = device.status;
  const switchKey = `switch:${CHANNEL}`;
  const current = status?.[switchKey]?.output;

  if (typeof current !== "boolean") {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: `Cannot read status["${switchKey}"].output`,
        online,
        statusKeys: Object.keys(status),
        // hilft enorm: zeigt dir, ob es evtl. "switch:0" anders heißt
        switchObj: status?.[switchKey] ?? null,
      }),
    };
  }

  const nextOn = !current;

  // 3) Schalten
  try {
    const setRes = await fetch(
      `${apiBase}/v2/devices/api/set/switch?auth_key=${encodeURIComponent(AUTH_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: DEVICE_ID, channel: CHANNEL, on: nextOn }),
      }
    );

    const text = await setRes.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!setRes.ok) {
      return {
        statusCode: 502,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          step: "set_http",
          status: setRes.status,
          body: json,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, from: current, to: nextOn, result: json }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, step: "set_fetch", error: String(e) }),
    };
  }
};
