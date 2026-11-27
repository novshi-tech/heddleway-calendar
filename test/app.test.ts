import { describe, expect, it } from "vitest";
import { clientMetadata, EXAMPLES, PORTS } from "../src/app";
import type { Env } from "../src/env";

// The same check as Heddleway's checkExamples (src/apps.ts): the path before the query must
// match a port of the service and method as a whole.
function allows(example: string): boolean {
  const m = example.match(/^([A-Z]+)\s+([a-z0-9-]+)\s+(\/\S*)$/);
  if (!m) return false;
  const path = m[3].split("?")[0];
  return PORTS.some((p) => p.service === m[2] && p.method === m[1] && new RegExp(p.path).test(path));
}

describe("app definition", () => {
  it("lets the allowed examples through and refuses the others", () => {
    for (const e of EXAMPLES.allow) expect(allows(e), e).toBe(true);
    for (const e of EXAMPLES.deny) expect(allows(e), e).toBe(false);
  });
  it("is a public client with its own URL as the client ID", () => {
    const doc = clientMetadata({ PUBLIC_URL: "https://cal.example.com/" } as Env);
    expect(doc.client_id).toBe("https://cal.example.com/client.json");
    expect(doc.redirect_uris).toEqual(["https://cal.example.com/connections/callback"]);
    expect(doc.token_endpoint_auth_method).toBe("none");
    for (const p of PORTS) expect(p.path.startsWith("^/") && p.path.endsWith("$")).toBe(true);
  });
});
