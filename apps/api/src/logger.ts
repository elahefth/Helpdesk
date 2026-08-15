import pino from "pino";
import { env, isProduction } from "./env.ts";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : isProduction ? "info" : "debug",
  // Pretty output is a dev convenience only; production emits newline JSON so
  // the platform's log shipper can parse it.
  transport: isProduction
    ? undefined
    : { target: "pino-pretty", options: { colorize: true } },
});

export type Logger = typeof logger;
