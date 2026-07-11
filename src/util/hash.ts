import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import type { DigestedEnvelope } from "../types";

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestPayload<T>(payload: T): DigestedEnvelope<T> {
  return {
    payload,
    digest: { algorithm: "sha256", value: sha256(canonicalJson(payload)) },
  };
}

export function hasValidDigest<T>(envelope: DigestedEnvelope<T>): boolean {
  return envelope.digest.value === sha256(canonicalJson(envelope.payload));
}
