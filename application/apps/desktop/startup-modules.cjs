// Code loading is independent of Electron readiness and does not open a data
// owner. Start it for the winning application instance while native startup is
// still in progress. Preserve failures until the existing ready/error boundary.
function prepareApplicationModules(load = (specifier) => import(specifier)) {
  try {
    return Promise.all([
      load("../../dist/service/packages/application/src/paths.js"),
      load("../../dist/service/apps/desktop/application-host.js"),
    ]).then(
      (modules) => ({ modules }),
      (error) => ({ error }),
    );
  } catch (error) {
    return Promise.resolve({ error });
  }
}

module.exports = { prepareApplicationModules };
