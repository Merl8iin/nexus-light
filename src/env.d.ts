interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  STORE: DurableObjectNamespace<import("./store").Store>;
  DOCS: DurableObjectNamespace<import("./doc").DocRoom>;
  OAUTH_KV: KVNamespace;
  /** Owner password for the consent page (wrangler secret put OWNER_PASSWORD). */
  OWNER_PASSWORD: string;
  /** Optional canonical origin, e.g. https://nexus.example.com (defaults to the request origin). */
  PUBLIC_URL?: string;
  /** Durable Object jurisdiction: "eu" (default) or "" for none. */
  DATA_REGION?: string;
  /** Optional ByCS (Bavarian school cloud) login; enables the bycs_*/moodle_* tools and Drive backups. */
  BYCS_USER?: string;
  BYCS_PASS?: string;
  /** ByCS school number, e.g. 0284 (required for ByCS). */
  BYCS_SCHOOL?: string;
  /** Where send_feedback posts to; "" disables the tool. Default: the developer's receiver. */
  FEEDBACK_URL?: string;
}
