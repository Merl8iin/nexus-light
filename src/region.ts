// Where Durable Objects keep their data. DATA_REGION="eu" (the default) pins storage to EU data
// centers; set it to "" for no restriction. Decide before storing data: existing objects never move.
export const region = (env: Env): DurableObjectJurisdiction | undefined => ((env.DATA_REGION ?? "eu") || undefined) as DurableObjectJurisdiction | undefined;

export function ns<T extends Rpc.DurableObjectBranded | undefined>(n: DurableObjectNamespace<T>, env: Env): DurableObjectNamespace<T> {
  const r = region(env);
  return r ? n.jurisdiction(r) : n;
}

export const storeStub = (env: Env) => { const n = ns(env.STORE, env); return n.get(n.idFromName("main")); };
export const docStub = (env: Env, id: string) => { const n = ns(env.DOCS, env); return n.get(n.idFromName(id)); };
