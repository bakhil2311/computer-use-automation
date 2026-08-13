import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import net from "node:net";

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

export async function launchSession(): Promise<LaunchedSession> {
  // The sandbox's pre-installed Chromium revision can trail the `playwright`
  // npm package's expected revision; pin the executable explicitly instead
  // of letting Playwright resolve (and try to download) its bundled build.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
  const port = await findFreePort();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
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
