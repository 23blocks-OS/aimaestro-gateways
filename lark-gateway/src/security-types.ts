/** Defines the shared content trust and injection scan types. */
export interface TrustResult {
  level: "operator" | "external";
  reason: string;
}
