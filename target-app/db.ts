// In-memory "core banking" data for the mock legacy target app. Fake data only.

export interface MemberAccount {
  type: string;
  number: string;
  balance: number;
}

export interface Member {
  id: string;
  name: string;
  status: "active" | "restricted";
  accounts: MemberAccount[];
}

export const members: Record<string, Member> = {
  "10234": {
    id: "10234",
    name: "Jane Doe",
    status: "active",
    accounts: [
      { type: "Checking", number: "CHK-10234-01", balance: 1204.55 },
      { type: "Savings", number: "SAV-10234-01", balance: 4582.1 },
    ],
  },
  "10235": {
    id: "10235",
    name: "John Smith",
    status: "active",
    accounts: [
      { type: "Checking", number: "CHK-10235-01", balance: 320.0 },
      { type: "Savings", number: "SAV-10235-01", balance: 912.44 },
    ],
  },
  "77777": {
    // triggers artificial slow load in the search handler
    id: "77777",
    name: "Slow Loader Test",
    status: "active",
    accounts: [{ type: "Savings", number: "SAV-77777-01", balance: 50.0 }],
  },
  "99999": {
    // permission-denied demo member
    id: "99999",
    name: "Restricted Member",
    status: "restricted",
    accounts: [{ type: "Savings", number: "SAV-99999-01", balance: 0 }],
  },
};

// per-process counter used by the "flaky" member (55555) to fail once, then succeed.
export const flakyState = { attempts: 0 };

let subAccountCounter = 1000;
export function nextSubAccountNumber(memberId: string): string {
  subAccountCounter += 1;
  return `SUB-${memberId}-${subAccountCounter}`;
}
