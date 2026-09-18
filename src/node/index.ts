import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "../worker/index";
import { settleExpiredEntitlements } from "../worker/finance";
import type { Env } from "../worker/types";
import { LocalDatabase } from "./database";

const port = Number(process.env.PORT || 3000);
const publicDirectory = resolve(process.env.PUBLIC_DIR || "dist/client");
const database = new LocalDatabase(resolve(process.env.DB_PATH || "data/boardless.sqlite"));
database.migrate(resolve(process.env.MIGRATIONS_DIR || "migrations"));

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const env: Env = {
  DB: database.asD1(),
  ASSETS: {} as Fetcher,
  APP_ORIGIN: process.env.APP_ORIGIN || `http://localhost:${port}`,
  SESSION_SECRET: required("SESSION_SECRET"),
  BOOTSTRAP_SECRET: required("BOOTSTRAP_SECRET"),
  ALIPAY_APP_ID: process.env.ALIPAY_APP_ID || "",
  ALIPAY_PRIVATE_KEY: process.env.ALIPAY_PRIVATE_KEY || "",
  ALIPAY_PUBLIC_KEY: process.env.ALIPAY_PUBLIC_KEY || "",
  ALIPAY_GATEWAY: process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do",
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

async function staticResponse(pathname: string) {
  let relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let file = resolve(publicDirectory, relativePath);
  if (file !== publicDirectory && !file.startsWith(`${publicDirectory}${sep}`)) return new Response("Not found", { status: 404 });
  try {
    const content = await readFile(file);
    return new Response(content, { headers: { "content-type": contentTypes[extname(file)] || "application/octet-stream" } });
  } catch {
    relativePath = "index.html";
    file = resolve(publicDirectory, relativePath);
    const content = await readFile(file);
    return new Response(content, { headers: { "content-type": contentTypes[extname(file)] } });
  }
}

const server = serve({
  port,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    return pathname.startsWith("/api/") || pathname.startsWith("/sub/") ? app.fetch(request, env) : staticResponse(pathname);
  },
}, (info) => console.log(`BoardLess 已启动：http://localhost:${info.port}`));

const settlementTimer = setInterval(() => {
  void settleExpiredEntitlements(env).catch((error) => console.error("权益结算失败", error));
}, 6 * 60 * 60 * 1000);
settlementTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  clearInterval(settlementTimer);
  server.close(() => { database.close(); process.exit(0); });
});
