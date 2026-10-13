# pi-openrouter-provider-picker

Choose an OpenRouter upstream endpoint for the currently selected model in Pi.

## Requirements

- Pi with the OpenRouter provider configured.
- OpenRouter authentication available to Pi. This is needed to retrieve the current model's endpoint list.

## Install

```bash
pi install npm:pi-openrouter-provider-picker
```

## Usage

1. In Pi, use `/model` to select an OpenRouter model.
2. Run `/or-provider` and choose one of the endpoints listed for that model.

   Each entry shows the provider name, its routing tag, and that endpoint's
   current price, for example:

   ```text
   OpenAI — openai · in $30/M · out $60/M · cache $7.50/M
   ```

   `in` and `out` are USD per million input and output tokens. `cache` is the
   discounted rate for cached input tokens and only appears when it is cheaper
   than the regular input rate. Endpoints that publish no price (for example
   free tiers) show no price at all.

   Endpoints that have recently stopped responding are flagged with their
   uptime over the most recent window that carries traffic:

   ```text
   Chutes — chutes · in $0.05/M · out $0.1/M · ⚠ up 62%
   ```

   Endpoints at or above 95% uptime are not flagged. A `null` uptime means no
   traffic was observed, not an outage, so it is never shown.

3. The selected endpoint is pinned for that model; provider fallback is disabled.
4. When you switch models, this extension clears its selection. The new model uses its normal routing.

The `Automatic` menu option leaves any model-level routing settings intact. If you have a fixed route in `models.json`, that setting continues to apply.

## Endpoint lookup and credentials

When `/or-provider` is opened, the extension makes a read-only GET request to OpenRouter's endpoint-list API for the selected model. It does not send a model-generation request to populate the menu.

No API key is bundled or written by this package. By default, the extension uses the OpenRouter credential already configured in Pi. To use a separate key only for endpoint lookup, set `OPENROUTER_METADATA_API_KEY` in the environment before starting Pi. Pi still needs its normal inference credential to generate responses.

The provider list is specific to the selected model. Choosing an endpoint that is unavailable for that model may cause the request to fail; this is intentional because the extension disables provider fallback.

## License

MIT © soubell

