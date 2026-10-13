import { env } from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTO_LABEL = "Automatic — use model/OpenRouter routing settings";
const CUSTOM_LABEL = "Enter a provider slug…";
const STATUS_KEY = "openrouter-provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getEndpointChoices(modelId: string, apiKey: string) {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new Error(`Cannot get OpenRouter endpoints for model ID: ${modelId}`);
  }

  const author = encodeURIComponent(modelId.slice(0, slash));
  const slug = encodeURIComponent(modelId.slice(slash + 1));
  const url = `https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
    throw new Error(`OpenRouter endpoint lookup failed: ${message}`);
  }

  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : undefined;
  if (!endpoints) throw new Error("OpenRouter returned an unexpected endpoint-list response.");

  const byTag = new Map<string, string>();
  for (const value of endpoints) {
    if (!isRecord(value) || typeof value.tag !== "string" || !value.tag) continue;
    const tag = value.tag;
    const providerName = typeof value.provider_name === "string" ? value.provider_name : tag;
    byTag.set(tag, `${providerName} — ${tag}`);
  }

  return [...byTag.entries()].map(([slug, label]) => ({ slug, label }));
}

export default function openRouterProviderExtension(pi: ExtensionAPI) {
  // A route choice applies only to the currently selected model.
  let selectedModelId: string | undefined;
  let selectedSlug: string | null | undefined;

  pi.registerCommand("or-provider", {
    description: "Choose an upstream endpoint for the current OpenRouter model",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/or-provider needs Pi's interactive UI.", "warning");
        return;
      }

      const model = ctx.model;
      if (!model || model.provider !== "openrouter") {
        ctx.ui.notify("Select an OpenRouter model with /model first.", "warning");
        return;
      }

      // A separate metadata-only key can be used without changing Pi's inference key.
      const apiKey =
        env.OPENROUTER_METADATA_API_KEY?.trim() ||
        (await ctx.modelRegistry.getApiKeyForProvider("openrouter"));
      if (!apiKey) {
        ctx.ui.notify("No OpenRouter API key is available to load this model's endpoints. Sign in with /login first.", "error");
        return;
      }

      let endpoints: Array<{ slug: string; label: string }>;
      try {
        endpoints = await getEndpointChoices(model.id, apiKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      if (endpoints.length === 0) {
        ctx.ui.notify(`OpenRouter reported no endpoints for ${model.id}.`, "warning");
        return;
      }

      const options = [
        AUTO_LABEL,
        ...endpoints.map((endpoint) => endpoint.label),
        CUSTOM_LABEL,
      ];
      const choice = await ctx.ui.select(`Upstream for ${model.id}`, options);
      if (!choice) return;

      let nextSlug: string | null;
      if (choice === AUTO_LABEL) {
        nextSlug = null;
      } else if (choice === CUSTOM_LABEL) {
        const entered = (await ctx.ui.input("Provider endpoint slug", "e.g. deepinfra or deepinfra/turbo"))?.trim();
        if (!entered) return;
        if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(entered)) {
          ctx.ui.notify("Invalid provider slug. Use the exact slug shown by OpenRouter.", "error");
          return;
        }
        nextSlug = entered;
      } else {
        nextSlug = endpoints.find((endpoint) => endpoint.label === choice)?.slug ?? null;
        if (nextSlug === null) return;
      }

      selectedModelId = model.id;
      selectedSlug = nextSlug;
      ctx.ui.setStatus(STATUS_KEY, `OpenRouter ${model.id}: ${nextSlug ?? "Auto"}`);
      ctx.ui.notify(
        nextSlug
          ? `${model.id} will use ${nextSlug} only (no provider fallback).`
          : `Automatic OpenRouter routing restored for ${model.id}.`,
        "info",
      );
    },
  });

  pi.on("model_select", (_event, ctx) => {
    if (selectedModelId === undefined) return;
    const wasPinned = selectedSlug !== undefined && selectedSlug !== null;
    selectedModelId = undefined;
    selectedSlug = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (wasPinned) {
      ctx.ui.notify("Model changed; provider override cleared and routing is automatic.", "info");
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "openrouter" || !isRecord(event.payload)) return;
    if (selectedSlug === undefined || selectedModelId !== model.id) return;

    // Auto leaves any model-level routing and privacy settings untouched. If there are
    // no such settings, OpenRouter applies its normal automatic routing.
    if (selectedSlug === null) return;

    const provider: Record<string, unknown> = isRecord(event.payload.provider)
      ? { ...event.payload.provider }
      : {};
    // A stale ignore rule must not contradict the provider chosen in the menu.
    delete provider.ignore;
    provider.only = [selectedSlug];
    provider.order = [selectedSlug];
    provider.allow_fallbacks = false;

    return { ...event.payload, provider };
  });
}
