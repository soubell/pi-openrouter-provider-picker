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
3. The selected endpoint is pinned for that model; provider fallback is disabled.
4. When you switch models, this extension clears its selection. The new model uses its normal routing.

The `Automatic` menu option leaves any model-level routing settings intact. If you have a fixed route in `models.json`, that setting continues to apply.

## Endpoint lookup and credentials

When `/or-provider` is opened, the extension makes a read-only GET request to OpenRouter's endpoint-list API for the selected model. It does not send a model-generation request to populate the menu.

No API key is bundled or written by this package. By default, the extension uses the OpenRouter credential already configured in Pi. To use a separate key only for endpoint lookup, set `OPENROUTER_METADATA_API_KEY` in the environment before starting Pi. Pi still needs its normal inference credential to generate responses.

The provider list is specific to the selected model. Choosing an endpoint that is unavailable for that model may cause the request to fail; this is intentional because the extension disables provider fallback.

## License

MIT © soubell

