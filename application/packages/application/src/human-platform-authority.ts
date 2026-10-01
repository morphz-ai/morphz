import { randomBytes } from "node:crypto";
import type { AccessContext } from "../../core/src/model.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformAuthorityVerifier,
} from "../../platform/src/store.js";

type Issued = {
  access: AccessContext;
  assertActive: () => void;
  expiresAt: number;
};

/** Bridges a trusted Host session into one Platform operation. The proof is
 * never sent to the renderer, model, or a persisted command body.
 */
export class HumanPlatformAuthority {
  private readonly issued = new Map<string, Issued>();

  constructor(
    readonly tenantId: string,
    private readonly verifyHuman: (
      access: AccessContext,
    ) => boolean | Promise<boolean>,
    private readonly now = Date.now,
  ) {}

  private async valid(issued: Issued) {
    issued.assertActive();
    if (this.now() >= issued.expiresAt) return false;
    return this.verifyHuman(issued.access);
  }

  async withSession<T>(
    access: AccessContext,
    assertActive: () => void,
    work: (actor: PlatformActor) => Promise<T>,
  ): Promise<T> {
    const issued: Issued = {
      access,
      assertActive,
      expiresAt: this.now() + 60_000,
    };
    if (!(await this.valid(issued)))
      throw new PlatformStorageError("forbidden", "当前用户身份已失效。");
    const credential = randomBytes(32).toString("hex");
    this.issued.set(credential, issued);
    try {
      return await work({ credential });
    } finally {
      this.issued.delete(credential);
    }
  }

  /** Compose with Runtime Agent and provider verification without extending
   * either one's authority to a Human session.
   */
  verifier(remaining: PlatformAuthorityVerifier): PlatformAuthorityVerifier {
    return {
      ...remaining,
      resolveActor: async (actor) => {
        const issued = this.issued.get(actor.credential);
        if (!issued) return remaining.resolveActor(actor);
        if (!(await this.valid(issued))) return null;
        return {
          tenantId: this.tenantId,
          principalId: issued.access.principalId,
          actantId: issued.access.actantId,
          kind: "human" as const,
          runtimeInputId: null,
        };
      },
    };
  }
}
