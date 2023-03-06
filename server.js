const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const ws = require("ws");
const zlib = require("zlib");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 3000;
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const signalrUrl = "livetiming.formula1.com/signalr";
const signalrHub = "Streaming";

const socketFreq = 500;

let state = {};
let messageCount = 0;

const deepObjectMerge = (original = {}, modifier) => {
  if (!modifier) return original;
  const copy = { ...original };
  for (const [key, value] of Object.entries(modifier)) {
    const valueIsObject =
      typeof value === "object" && !Array.isArray(value) && value !== null;
    if (valueIsObject && !!Object.keys(value).length) {
      copy[key] = deepObjectMerge(copy[key], value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
};

const parseCompressed = (data) =>
  JSON.parse(zlib.inflateRawSync(Buffer.from(data, "base64")).toString());

const setupStream = async () => {
  console.log("connecting to live timing stream...");

  const wss = new ws.WebSocketServer({ port: port + 1 });

  // Assume we have an active session after 5 messages
  setInterval(() => {
    wss.clients.forEach((s) => {
      if (s.readyState === ws.OPEN) {
        s.send(
          messageCount > 5 || process.env.NODE_ENV !== "production"
            ? JSON.stringify(state)
            : "{}",
          {
            binary: false,
          }
        );
      }
    });
  }, socketFreq);

  const hub = encodeURIComponent(JSON.stringify([{ name: signalrHub }]));
  const negotiation = await fetch(
    `https://${signalrUrl}/negotiate?connectionData=${hub}&clientProtocol=1.5`
  );
  const cookie = negotiation.headers.get("set-cookie");
  const { ConnectionToken } = await negotiation.json();

  if (cookie && ConnectionToken) {
    console.log("negotiation complete");

    const socket = new ws(
      `wss://${signalrUrl}/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodeURIComponent(
        ConnectionToken
      )}&connectionData=${hub}`,
      [],
      {
        headers: {
          "User-Agent": "BestHTTP",
          "Accept-Encoding": "gzip,identity",
          Cookie: cookie,
        },
      }
    );

    socket.on("open", () => {
      console.log("websocket open");

      state = {};

      socket.send(
        JSON.stringify({
          H: signalrHub,
          M: "Subscribe",
          A: [
            [
              "Heartbeat",
              "CarData.z",
              "Position.z",
              "ExtrapolatedClock",
              "TopThree",
              "RcmSeries",
              "TimingStats",
              "TimingAppData",
              "WeatherData",
              "TrackStatus",
              "DriverList",
              "RaceControlMessages",
              "SessionInfo",
              "SessionData",
              "LapCount",
              "TimingData",
            ],
          ],
          I: 1,
        })
      );
    });

    socket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        if (Array.isArray(parsed.M)) {
          for (const message of parsed.M) {
            if (message.M === "feed") {
              messageCount++;

              let { field, value } = message.A;

              if (field === "CarData.z" || field === "Position.z") {
                const [parsedField] = field.split(".");
                field = parsedField;
                value = parseCompressed(value);
              }

              state = deepObjectMerge(state, { [field]: value });
            }
          }
        } else if (Object.keys(parsed.R ?? {}).length && parsed.I === "1") {
          messageCount++;

          if (parsed.R["CarData.z"])
            parsed.R["CarData"] = parseCompressed(parsed.R["CarData.z"]);

          if (parsed.R["Position.z"])
            parsed.R["Position"] = parseCompressed(parsed.R["Position.z"]);

          state = deepObjectMerge(state, parsed.R);
        }
      } catch (e) {
        console.error(`could not update data: ${e}`);
      }
    });
  } else {
    console.log("negotiation failed. is there a live session?");
  }
};

app.prepare().then(async () => {
  await setupStream();
  createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  })
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});