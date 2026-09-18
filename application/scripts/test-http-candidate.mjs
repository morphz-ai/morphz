// Isolated test-process resolver. Production imports and the original HTTP adapter are untouched.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/tests/") && specifier === "../apps/service/src/http.js")
      return next("../apps/service/src/http-candidate.ts", context);
    return next(specifier, context);
  },
});
