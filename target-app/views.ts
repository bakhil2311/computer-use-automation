// Deliberately "legacy enterprise" markup: tables for layout, generated
// ASP.NET-style ids, no data-testid attributes, minimal semantics. This is
// the surface the discovery agent and the replay engine both have to cope
// with — see REPORT.md section 3/4.

export function page(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><title>${title} - CU Servicing Console</title>
<style>
  body { font-family: Tahoma, Arial, sans-serif; font-size: 13px; background:#eef1f5; margin:0; }
  .topbar { background:#2b3a55; color:#fff; padding:8px 12px; }
  table.layout { width:100%; border-collapse:collapse; }
  table.data { border-collapse:collapse; margin:10px; }
  table.data td, table.data th { border:1px solid #99a; padding:4px 8px; font-size:12px; }
  .msg-error { color:#a10000; background:#ffe5e5; border:1px solid #a10000; padding:6px; margin:10px; }
  .msg-info { color:#004a1f; background:#e5ffe9; border:1px solid #004a1f; padding:6px; margin:10px; }
  .panel { background:#fff; border:1px solid #99a; margin:10px; padding:10px; }
</style>
</head>
<body>
<div class="topbar">CU Servicing Console &mdash; internal use only</div>
${body}
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Login",
    `
<table class="layout"><tr><td style="padding:40px;">
  <div class="panel" style="max-width:320px;">
  <table class="data">
    <tr><td colspan="2"><b>Operator Sign In</b></td></tr>
    ${error ? `<tr><td colspan="2"><div class="msg-error">${error}</div></td></tr>` : ""}
    <tr><td>Username</td><td><input type="text" name="username" id="ctl00_lgn_uname" /></td></tr>
    <tr><td>Password</td><td><input type="password" name="password" id="ctl00_lgn_pwd" /></td></tr>
    <tr><td colspan="2" align="right">
      <form method="post" action="/login" id="ctl00_lgn_form">
        <input type="hidden" name="username" id="hid_u"/>
        <input type="hidden" name="password" id="hid_p"/>
      </form>
      <button type="button" id="ctl00_lgn_btnSubmit" onclick="doLogin()">Sign In</button>
    </td></tr>
  </table>
  </div>
</td></tr></table>
<script>
function doLogin(){
  var f = document.forms['ctl00_lgn_form'];
  f.username.value = document.getElementById('ctl00_lgn_uname').value;
  f.password.value = document.getElementById('ctl00_lgn_pwd').value;
  f.submit();
}
</script>`
  );
}

export function dashboardPage(): string {
  return page(
    "Dashboard",
    `
<table class="layout"><tr>
  <td style="width:140px; vertical-align:top; background:#dfe4ec;">
    <table class="data" style="width:100%;">
      <tr><td>Member Lookup</td></tr>
      <tr><td>Reports</td></tr>
      <tr><td><a href="/logout">Sign Out</a></td></tr>
    </table>
  </td>
  <td style="vertical-align:top;">
    <div class="panel">
      <b>Member Servicing</b>
      <iframe id="ctl00_mainFrame" name="ctl00_mainFrame" src="/member/search" style="width:100%;height:560px;border:1px solid #99a;"></iframe>
    </div>
  </td>
</tr></table>`
  );
}

export function searchPage(opts: { error?: string; notFound?: string; denied?: string; memberId?: string }): string {
  const { error, notFound, denied, memberId } = opts;
  return page(
    "Member Search",
    `
<form method="get" action="/member/search" id="ctl00_srch_form"></form>
<table class="data">
  <tr><td colspan="2"><b>Search for Member</b></td></tr>
  ${error ? `<tr><td colspan="2"><div class="msg-error">${error}</div></td></tr>` : ""}
  ${notFound ? `<tr><td colspan="2"><div class="msg-info">${notFound}</div></td></tr>` : ""}
  ${denied ? `<tr><td colspan="2"><div class="msg-error">${denied}</div></td></tr>` : ""}
  <tr>
    <td><label for="ctl00_srch_txtId">Member ID</label></td>
    <td><input type="text" name="memberId" id="ctl00_srch_txtId" form="ctl00_srch_form" value="${memberId ?? ""}" /></td>
  </tr>
  <tr><td colspan="2" align="right">
    <button type="submit" form="ctl00_srch_form" id="ctl00_srch_btnGo">Search</button>
  </td></tr>
</table>`
  );
}

export function memberDetailPage(m: {
  id: string;
  name: string;
  accounts: { type: string; number: string; balance: number }[];
}): string {
  const rows = m.accounts
    .map(
      (a) =>
        `<tr><td>${a.type}</td><td>${a.number}</td><td align="right">$${a.balance.toFixed(2)}</td></tr>`
    )
    .join("\n");
  return page(
    "Member Detail",
    `
<table class="data">
  <tr><td colspan="3"><b>Member ${m.id} &mdash; ${m.name}</b></td></tr>
  <tr><th>Account Type</th><th>Account #</th><th>Balance</th></tr>
  ${rows}
</table>
<div style="margin:10px;">
  <button type="button" id="ctl00_det_btnOpenSub" onclick="confirmOpenSub()">Open Sub-Account</button>
</div>
<form method="post" action="/member/${m.id}/subaccount" id="ctl00_det_subForm"></form>
<script>
function confirmOpenSub(){
  if (confirm('Are you sure you want to open a new sub-account for this member? This action cannot be undone.')) {
    document.getElementById('ctl00_det_subForm').submit();
  }
}
</script>`
  );
}

export function subAccountConfirmationPage(memberId: string, subAccountNumber: string): string {
  return page(
    "Sub-Account Opened",
    `
<div class="panel">
  <div class="msg-info" id="ctl00_conf_msg">Sub-account <b>${subAccountNumber}</b> was opened successfully for member ${memberId}.</div>
  <p>Confirmation #: <span id="ctl00_conf_num">${subAccountNumber}</span></p>
</div>`
  );
}

export function sessionExpiredPage(): string {
  return page(
    "Session Expired",
    `<div class="msg-error" style="margin:20px;">Your session has expired. Please <a href="/login" id="ctl00_reauth_link">sign in again</a>.</div>`
  );
}
