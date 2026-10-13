import { env } from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTO_LABEL = "Automatic — use model/OpenRouter routing settings";
const CUSTOM_LABEL = "Enter a provider slug…";
const STATUS_KEY = "openrouter-provider";

/** Endpoints at or above this uptime are not worth flagging in the menu. */
const UPTIME_WARNING_THRESHOLD = 95;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? Number.NaN : Number(value);
  return Number.NaN;
}

/** Render a USD amount without trailing zeros (e.g. 30, 0.025, 0.001). */
function formatUsd(amount: number): string {
  const text = amount >= 1 ? amount.toFixed(2) : amount.toPrecision(3);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/**
 * OpenRouter prices `prompt`/`completion` per token (USD), while `request` is
 * charged per request. Returns "" when the endpoint publishes no pricing.
 */
function formatPriceSuffix(pricing: unknown): string {
  if (!isRecord(pricing)) return "";

  const parts: string[] = [];
  const addPerToken = (label: string, raw: unknown): void => {
    const perToken = asNumber(raw);
    if (!Number.isFinite(perToken) || perToken <= 0) return;
    parts.push(`${label} $${formatUsd(perToken * 1_000_000)}/M`);
  };

  addPerToken("in", pricing.prompt);
  addPerToken("out", pricing.completion);

  // Cached input is billed at its own (cheaper) rate; only mention a real discount.
  const cache = asNumber(pricing.input_cache_read);
  const input = asNumber(pricing.prompt);
  const cheaperCache =
    Number.isFinite(cache) &&
    cache > 0 &&
    !(Number.isFinite(input) && input > 0 && cache >= input);
  if (cheaperCache) {
    parts.push(`cache $${formatUsd(cache * 1_000_000)}/M`);
  }

  const perRequest = asNumber(pricing.request);
  if (Number.isFinite(perRequest) && perRequest > 0) {
    parts.push(`$${formatUsd(perRequest)}/req`);
  }

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Prefer the freshest window that actually carries traffic. `null` means no
 * traffic was observed, which is not the same as being down.
 */
function firstUptime(endpoint: Record<string, unknown>): number | undefined {
  for (const key of ["uptime_last_5m", "uptime_last_30m", "uptime_last_1d"]) {
    const uptime = asNumber(endpoint[key]);
    if (Number.isFinite(uptime)) return uptime;
  }
  return undefined;
}

/** Flag a degraded endpoint only; healthy ones stay out of the way. */
function formatUptimeWarning(endpoint: unknown): string {
  if (!isRecord(endpoint)) return "";
  const uptime = firstUptime(endpoint);
  if (uptime === undefined || uptime >= UPTIME_WARNING_THRESHOLD) return "";
  return ` · ⚠ up ${Math.floor(uptime)}%`;
}

/**
 * East Asian wide/fullwidth ranges. Provider names are normally ASCII, so this
 * only matters when a name carries CJK text.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Terminal columns a string occupies, so menu columns can be aligned. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    width += WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
      ? 2
      : 1;
  }
  return width;
}

function padEndWidth(text: string, target: number): string {
  const missing = target - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

type EndpointChoice = {
  slug: string;
  base: string;
  price: string;
  health: string;
};

function buildChoice(endpoint: unknown, tag: string, providerName: string): EndpointChoice {
  const value = isRecord(endpoint) ? endpoint : {};
  return {
    slug: tag,
    base: `${providerName} — ${tag}`,
    price: formatPriceSuffix(value.pricing),
    health: formatUptimeWarning(value),
  };
}

/**
 * Pad the name and price blocks to their widest entry so every price starts at
 * the same column and the health flag lines up at the end.
 */
function alignChoices(choices: EndpointChoice[]): Array<{ slug: string; label: string }> {
  const baseWidth = Math.max(0, ...choices.map((c) => displayWidth(c.base)));
  const priceWidth = Math.max(0, ...choices.map((c) => displayWidth(c.price)));

  return choices.map((choice) => ({
    slug: choice.slug,
    label: (
      padEndWidth(choice.base, baseWidth) +
      padEndWidth(choice.price, priceWidth) +
      choice.health
    ).trimEnd(),
  }));
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

  const byTag = new Map<string, EndpointChoice>();
  for (const value of endpoints) {
    if (!isRecord(value) || typeof value.tag !== "string" || !value.tag) continue;
    const tag = value.tag;
    const providerName = typeof value.provider_name === "string" ? value.provider_name : tag;
    byTag.set(tag, buildChoice(value, tag, providerName));
  }

  return alignChoices([...byTag.values()]);
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
