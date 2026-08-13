import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import net from "node:net";
import fs from "node:fs";

/**
 * Owns the actual browser process for a run. We launch a normal Chromium
 * process with its Chrome DevTools Protocol port exposed
 * (`--remote-debugging-port`) rather than a Playwright "browser server":
 * CDP is what a *separate OS process* — the operator CLI — can attach to
 * via `chromium.connectOverCDP(url)` and see the exact same live
 * contexts/pages/targets the automation process is driving. (We verified
 * Playwright's own `launchServer`/`connect` pairing does *not* share
 * contexts across independently-connected clients; raw CDP does, which is
 * also how a real remote-debugging/co-browsing console would attach in
 * production.) That's the concrete mechanism behind "same live session,
 * not a fresh one" in REPORT.md section 5.
 */
export interface LaunchedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdpUrl: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Some environments (e.g. the sandbox this project was originally built in)
 * pre-install a Chromium build outside Playwright's own managed cache, at a
 * revision the `playwright` npm package doesn't expect, so we pin an
 * explicit executable there instead of letting Playwright resolve its own.
 * On a normal machine (e.g. after `npx playwright install chromium`), no
 * such override exists or is needed — we let Playwright find its own
 * bundled build. `PLAYWRIGHT_CHROMIUM_PATH` lets anyone opt into an explicit
 * path if they have one.
 */
const SANDBOX_CHROMIUM_PATH = "/opt/pw-browsers/chromium";

function resolveExecutablePath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (fs.existsSync(SANDBOX_CHROMIUM_PATH)) return SANDBOX_CHROMIUM_PATH;
  return undefined; // let Playwright resolve its own managed browser
}

export async function launchSession(): Promise<LaunchedSession> {
  const executablePath = resolveExecutablePath();
  const port = await findFreePort();

  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [`--remote-debugging-port=${port}`],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  return { browser, context, page, cdpUrl: `http://127.0.0.1:${port}` };
}

/** Used by the operator CLI (a separate process) to attach to a running session over CDP. */
export async function attachToSession(cdpUrl: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context found on the shared session — has it exited?");
  const pages = context.pages();
  const page = pages[pages.length - 1];
  if (!page) throw new Error("No open page found on the shared session.");
  return { browser, page };
}

export async function closeSession(s: LaunchedSession): Promise<void> {
  await s.context.close().catch(() => {});
  await s.browser.close().catch(() => {});
}