import pino, { type DestinationStream, type Logger } from "pino";

const REDACTED_PATHS = [
  "apiKey",
  "token",
  "xToken",
  "privateKey",
  "seedPhrase",
  "mnemonic",
  "secret",
  "headers.x-api-key",
  "config.*.apiKey",
  "config.*.token",
  "rawTransaction",
  "transaction",
];

export function createLogger(
  level = "info",
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  };
  return destination ? pino(options, destination) : pino(options);
}
