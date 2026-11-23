import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #149: the README only pointed to setup.sh, so a self-hoster landing here first missed the
// installer, now the only way to self-host.
describe("README", () => {
  // Relative to this file, so it works whichever folder vitest starts in (polish-3 F8).
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  const selfHost = readme.slice(readme.indexOf("## Self-host it"), readme.indexOf("## Develop"));

  // Hardening D: the backend's setup.sh, Docker and GitHub Actions path is gone.
  // fails_when=the README sends anyone to setup.sh, Docker or the Vercel button again
  it("offers only npx create-alopex to self-host", () => {
    expect(selfHost).toMatch(/npx create-alopex/);
    expect(readme).not.toMatch(/setup\.sh|docker|Deploy button|Older path/i);
  });

  // polish-5 I1/I2/I5: "run it again in the same folder" sent people into the install folder (a
  // second install inside it), npx could reuse an old cached installer, and the npx path linked to
  // the backend's setup.sh steps. fails_when=the update wording or the npx link comes back
  it("says how to update and links the installer's own guide", () => {
    expect(readme).not.toMatch(/in the same folder/);
    expect(readme).toMatch(/npx create-alopex@latest/);
    expect(selfHost).toMatch(/alopex\/blob\/main\/installer\/README\.md/);
  });
});
