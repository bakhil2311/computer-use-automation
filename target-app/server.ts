import express from "express";
import crypto from "node:crypto";
import {
  loginPage,
  dashboardPage,
  searchPage,
  memberDetailPage,
  subAccountConfirmationPage,
  sessionExpiredPage,
  page,
} from "./views.js";
import { members, flakyState, nextSubAccountNumber } from "./db.js";

// Fake, local-only credentials for a mock target app. Not a real institution.
const VALID_USER = "operator1";
const VALID_PASS = "Passw0rd!";
const SESSION_TTL_MS = 10 * 60 * 1000;

interface Session {
  username: string;
  createdAt: number;
}
const sessions = new Map<string, Session>();

// add the flaky demo member here (not in db.ts to keep intent local to server)
members["55555"] = {
  id: "55555",
  name: "Flaky Load Test",
  status: "active",
  accounts: [{ type: "Savings", number: "SAV-55555-01", balance: 2200.0 }],
};

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  (req as any).sid = cookies["sid"];
  (req as any).session = cookies["sid"] ? sessions.get(cookies["sid"]) : undefined;
  next();
});

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const forceTimeout = req.header("x-simulate-timeout") === "1";
  const session: Session | undefined = (req as any).session;
  if (forceTimeout && (req as any).sid) {
    sessions.delete((req as any).sid);
  }
  const stillValid = session && Date.now() - session.createdAt < SESSION_TTL_MS && !forceTimeout;
  if (!stillValid) {
    res.status(440).send(sessionExpiredPage());
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// demo-only utility to make replay evidence deterministic/repeatable across runs.
// Not part of the "real" app surface — documented in README.
app.post("/__test__/reset", (_req, res) => {
  flakyState.attempts = 0;
  res.json({ ok: true });
});

app.get("/login", (_req, res) => {
  res.send(loginPage());
});

app.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === VALID_USER && password === VALID_PASS) {
    const sid = crypto.randomUUID();
    sessions.set(sid, { username, createdAt: Date.now() });
    res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/`);
    res.redirect("/dashboard");
  } else {
    res.status(401).send(loginPage("Invalid username or password."));
  }
});

app.get("/logout", (req, res) => {
  const sid = (req as any).sid;
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.redirect("/login");
});

app.get("/dashboard", requireAuth, (_req, res) => {
  res.send(dashboardPage());
});

app.get("/member/search", requireAuth, async (req, res) => {
  const memberIdRaw = (req.query.memberId as string | undefined)?.trim();

  if (!memberIdRaw) {
    res.send(searchPage({}));
    return;
  }

  if (!/^\d{5}$/.test(memberIdRaw)) {
    res.send(searchPage({ error: "Invalid Member ID format. Enter a 5-digit numeric ID.", memberId: memberIdRaw }));
    return;
  }

  if (memberIdRaw === "77777") {
    await new Promise((r) => setTimeout(r, 3000)); // transient slowness
  }

  if (memberIdRaw === "55555" && flakyState.attempts === 0) {
    flakyState.attempts += 1;
    res.status(503).send(page("Error", `<div class="msg-error" style="margin:20px;">Temporary system error. Please retry your search.</div>`));
    return;
  }

  const member = members[memberIdRaw];

  if (!member) {
    res.send(searchPage({ notFound: `No records found for Member ID ${memberIdRaw}.`, memberId: memberIdRaw }));
    return;
  }

  if (member.status === "restricted") {
    res.send(
      searchPage({
        denied: "Access denied: this member's record requires elevated permissions.",
        memberId: memberIdRaw,
      })
    );
    return;
  }

  res.send(
    page(
      "Member Search",
      `<form method="get" action="/member/search" id="ctl00_srch_form"></form>
      <table class="data">
        <tr><td colspan="2"><b>Search for Member</b></td></tr>
        <tr><td><label for="ctl00_srch_txtId">Member ID</label></td><td><input type="text" name="memberId" id="ctl00_srch_txtId" form="ctl00_srch_form" value="${memberIdRaw}" /></td></tr>
        <tr><td colspan="2" align="right">
          <button type="submit" form="ctl00_srch_form" id="ctl00_srch_btnGo">Search</button>
        </td></tr>
        <tr><th>Member</th><th></th></tr>
        <tr><td>${member.name} (#${member.id})</td><td><a href="/member/${member.id}/detail" id="ctl00_srch_lnkView_${member.id}">View</a></td></tr>
      </table>`
    )
  );
});

app.get("/member/:id/detail", requireAuth, (req, res) => {
  const member = members[String(req.params.id)];
  if (!member) {
    res.status(404).send(page("Not Found", `<div class="msg-error" style="margin:20px;">Member not found.</div>`));
    return;
  }
  res.send(memberDetailPage(member));
});

app.post("/member/:id/subaccount", requireAuth, (req, res) => {
  const member = members[String(req.params.id)];
  if (!member) {
    res.status(404).send(page("Not Found", `<div class="msg-error" style="margin:20px;">Member not found.</div>`));
    return;
  }
  const subAccountNumber = nextSubAccountNumber(member.id);
  member.accounts.push({ type: "Sub-Account", number: subAccountNumber, balance: 0 });
  res.send(subAccountConfirmationPage(member.id, subAccountNumber));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4178;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[target-app] mock legacy CU servicing console listening on http://localhost:${PORT}`);
});
