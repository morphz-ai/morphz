import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewMethod,
  type CognitiveAppViewRequestMap,
  type CognitiveAppViewResponseMap,
} from "../../core/src/cognitive-app-view-api.js";
import { DomainError } from "../../core/src/model.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformStore,
} from "../../platform/src/store.js";
import type { CognitiveAppViewBinding } from "../../platform/src/cognitive-app-registry.js";
import type { ApplicationInstance } from "../../core/src/applications.js";
import type { UiPackageService } from "./ui-package-service.js";
import { CognitiveAppServiceError } from "./cognitive-app-service.js";

function safe(error: unknown, commandId?: string) {
  if (error instanceof CognitiveAppServiceError)
    return new CognitiveAppServiceError(
      error.reason,
      commandId ?? error.commandId,
    );
  if (error instanceof PlatformStorageError || error instanceof DomainError) {
    const reason = error.code;
    if (
      reason === "invalid" ||
      reason === "forbidden" ||
      reason === "not_found" ||
      reason === "conflict"
    )
      return new CognitiveAppServiceError(reason, commandId);
  }
  return new CognitiveAppServiceError("unavailable", commandId);
}
function publicMetadata(
  view: ApplicationInstance,
  binding: CognitiveAppViewBinding | null,
) {
  if (!binding) throw new CognitiveAppServiceError("not_found");
  const {
    id,
    workspaceId,
    applicationId,
    applicationVersion,
    revision,
    state,
    status,
    createdAt,
    updatedAt,
  } = view;
  const {
    appId,
    version,
    instanceId,
    serviceId,
    dataAuthorityId,
    viewId,
    projectId,
    connectionId,
    revision: bindingRevision,
    viewRevision,
    createdAt: boundAt,
    updatedAt: bindingUpdatedAt,
  } = binding;
  return {
    view: {
      id,
      workspaceId,
      applicationId,
      applicationVersion,
      revision,
      state,
      status,
      createdAt,
      updatedAt,
    },
    binding: {
      appId,
      version,
      instanceId,
      serviceId,
      dataAuthorityId,
      viewId,
      projectId,
      connectionId,
      revision: bindingRevision,
      viewRevision,
      createdAt: boundAt,
      updatedAt: bindingUpdatedAt,
    },
  };
}
/** Six Human-only presentation methods. No guest operation, new registry,
 * lifecycle scheduler, transport, authority construction or business write. */
export type CognitiveAppViewPlatform = Pick<
  PlatformStore,
  | "launchCognitiveAppView"
  | "bindCognitiveAppView"
  | "readCognitiveAppView"
  | "changeCognitiveAppView"
>;
export function createCognitiveAppViewService(options: {
  platform: CognitiveAppViewPlatform;
  uiPackages?: UiPackageService;
}) {
  const { platform, uiPackages } = options;
  async function run<M extends CognitiveAppViewMethod>(
    method: M,
    actor: PlatformActor,
    input: unknown,
    work: (
      access: PlatformActor,
      request: CognitiveAppViewRequestMap[M],
    ) => Promise<unknown>,
  ): Promise<CognitiveAppViewResponseMap[M]> {
    let commandId: string | undefined;
    try {
      let request: CognitiveAppViewRequestMap[M];
      try {
        request = parseCognitiveAppViewRequest(method, input);
      } catch {
        throw new CognitiveAppServiceError("invalid");
      }
      if ("commandId" in request) commandId = request.commandId;
      const access = { credential: actor.credential };
      const result = await work(access, request);
      try {
        return parseCognitiveAppViewResponse(method, result);
      } catch {
        throw new CognitiveAppServiceError("contract", commandId);
      }
    } catch (error) {
      throw safe(error, commandId);
    }
  }
  return {
    launch(actor: PlatformActor, input: unknown) {
      return run("launch", actor, input, (access, request) =>
        platform.launchCognitiveAppView(access, request),
      );
    },
    bind(actor: PlatformActor, input: unknown) {
      return run("bind", actor, input, (access, request) =>
        platform.bindCognitiveAppView(access, request),
      );
    },
    read(actor: PlatformActor, input: unknown) {
      return run("read", actor, input, async (access, request) => {
        const { view, binding } = await platform.readCognitiveAppView(
          access,
          request,
        );
        return publicMetadata(view, binding);
      });
    },
    readUi(actor: PlatformActor, input: unknown) {
      return run("readUi", actor, input, async (access, request) => {
        if (!uiPackages) throw new CognitiveAppServiceError("unavailable");
        const response = await uiPackages.readCognitive(access, request);
        return {
          ...publicMetadata(response.view, response.binding),
          manifest: response.manifest,
          definition: response.definition,
          authority: response.authority,
          grantRevision: response.grantRevision,
          connectionRevision: response.connectionRevision,
        };
      });
    },
    save(actor: PlatformActor, input: unknown) {
      return run("save", actor, input, (access, request) =>
        platform.changeCognitiveAppView(access, request),
      );
    },
    close(actor: PlatformActor, input: unknown) {
      return run("close", actor, input, (access, request) =>
        platform.changeCognitiveAppView(access, { ...request, close: true }),
      );
    },
  };
}
export type CognitiveAppViewService = ReturnType<
  typeof createCognitiveAppViewService
>;
