import { handle } from "@/src/server/http";
import { getSettings } from "@/src/server/store";
import { PROVIDERS, probe } from "@/src/server/providers";
import type { ProviderId } from "@/src/core/types";

/** Version probe for every supported CLI; `claude` stays the field the UI reads for the active one. */
export async function GET(req: Request) {
  return handle(req, async () => {
    const s = getSettings();
    const ids = Object.keys(PROVIDERS) as ProviderId[];
    const paths: Record<ProviderId, string> = {
      claude: s.claudePath,
      ...Object.fromEntries(Object.entries(s.providers).map(([k, v]) => [k, v.path])),
    } as Record<ProviderId, string>;
    const nodes: Partial<Record<ProviderId, string>> = Object.fromEntries(Object.entries(s.providers).map(([k, v]) => [k, v.node]));
    const results = await Promise.all(ids.map((id) => probe(paths[id] || PROVIDERS[id].defaultPath, id, nodes[id])));
    const providers = Object.fromEntries(ids.map((id, i) => [id, results[i]]));
    return { provider: s.provider, providerName: PROVIDERS[s.provider].name, claude: providers[s.provider], providers };
  });
}
