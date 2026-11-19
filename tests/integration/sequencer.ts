import { BaseSequencer, type TestSpecification } from "vitest/node";

/** auth.test.ts completes first-run setup, which the other suites sign in after. */
export default class AuthFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const sorted = await super.sort(files);
    const first = (file: TestSpecification) => file.moduleId.endsWith("/auth.test.ts");
    return [...sorted.filter(first), ...sorted.filter((file) => !first(file))];
  }
}
