import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTIONS);

let dummyHash: Promise<string> | undefined;

/** Verifies a password, spending the same time when the user doesn't exist. */
export async function verifyPassword(stored: string | undefined, password: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}
