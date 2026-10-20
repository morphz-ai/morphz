import { prepareCognitiveAuthorDependencies } from "../tests/fixtures/cognitive-app-packed-author.js";

// This is deliberately an explicit preparation command, not a network
// fallback in the test fixture. Only its locked third-party dependencies are
// fetched; both the SDK and author are installed in temporary isolated roots.
prepareCognitiveAuthorDependencies();
console.log(
  "Prepared exact cognitive SDK/author dependency locks; Runtime tests remain offline.",
);
