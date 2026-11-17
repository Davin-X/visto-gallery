import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import rules from "../src-tauri/src/commands/cleanup_rules.json";
import schema from "../src-tauri/src/commands/cleanup_rules.schema.json";

/**
 * Two validators read `cleanup_rules.json`: this schema, which an editor uses
 * while the file is being written, and `validate_rules` in Rust, which is what
 * actually gates the binary. The schema is not generated from the Rust types,
 * so nothing stops the two from drifting; this pins the shipped file to it so
 * a schema edit that no longer describes the data fails the build.
 */
describe("cleanup rules data", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  it("matches cleanup_rules.schema.json", () => {
    const ok = validate(rules);
    expect(ok, ajv.errorsText(validate.errors)).toBe(true);
  });

  // Guards against a schema so permissive that the test above cannot fail.
  it("rejects a file with a rule list missing", () => {
    expect(validate({ static: rules.static, artifacts: rules.artifacts })).toBe(false);
  });
});
