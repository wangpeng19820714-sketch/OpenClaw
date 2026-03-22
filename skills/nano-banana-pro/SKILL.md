| name            | description                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nano-banana-pro | Generate and edit images using Google's Nano Banana Pro (Gemini 3 Pro Image) API. Use when the user asks to generate, create, edit, modify, change, alter, or update images. Also use when user references an existing image file and asks to modify it in any way (e.g., "modify this image", "change the background", "replace X with Y"). Supports both text-to-image generation and image-to-image editing with configurable resolution (1K default, 2K, or 4K for high resolution). |

DO NOT read the image file first - use this skill directly with the --input-image parameter.

# Nano Banana Pro Image Generation & Editing

Generate new images or edit existing ones using Google's Nano Banana Pro API (Gemini 3 Pro Image).

## Usage

Run the script using absolute path (do NOT cd to skill directory first):

Generate new image:

    uv run ~/.claude/skills/nano-banana-pro/scripts/generate_image.py --prompt "your image description" --filename "output-name.png" [--resolution 1K|2K|4K] [--api-key KEY]

Edit existing image:

    uv run ~/.claude/skills/nano-banana-pro/scripts/generate_image.py --prompt "editing instructions" --filename "output-name.png" --input-image "path/to/input.png" [--resolution 1K|2K|4K] [--api-key KEY]

Important: Always run from the user's current working directory so images are saved where the user is working, not in the skill directory.

## Authentication

The script now supports two auth modes:

- `api-key` (default if `GEMINI_API_KEY` or `--api-key` is present): Gemini Developer API
- `oauth`: Vertex AI using Google Cloud credentials

OAuth mode is useful when the user wants account-based login instead of an API key, but it is **not** the same thing as Gemini web membership. It uses a Google Cloud project and Vertex AI permissions/billing.

Common OAuth setup:

    export GOOGLE_CLOUD_PROJECT="your-project-id"
    export GOOGLE_CLOUD_LOCATION="global"
    export GEMINI_OAUTH_CLIENT_SECRET="/path/to/client_secret.json"
    uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --auth-mode oauth --prompt "your image description" --filename "output-name.png"

The first OAuth run opens a browser, stores a refresh token locally, and reuses it next time. By default the token is cached at `~/.config/nano-banana-pro/token.json`.

If the user already has Application Default Credentials, the script can also run in OAuth mode without `GEMINI_OAUTH_CLIENT_SECRET`:

    export GOOGLE_CLOUD_PROJECT="your-project-id"
    export GOOGLE_CLOUD_LOCATION="global"
    uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --auth-mode oauth --prompt "your image description" --filename "output-name.png"

## Resolution Options

The Gemini 3 Pro Image API supports three resolutions (uppercase K required):

- 1K (default) - ~1024px resolution
- 2K - ~2048px resolution
- 4K - ~4096px resolution

Map user requests to API parameters:

- No mention of resolution → `1K`
- "low resolution", "1080", "1080p", "1K" → `1K`
- "2K", "2048", "normal", "medium resolution" → `2K`
- "high resolution", "high-res", "hi-res", "4K", "ultra" → `4K`

## API Key

For `api-key` mode, the script checks in this order:

1. `--api-key` argument (use if user provided key in chat)
2. `GEMINI_API_KEY` environment variable

For `oauth` mode, the script checks in this order:

1. `--project` argument
2. `GOOGLE_CLOUD_PROJECT` environment variable
3. optional desktop client JSON from `--oauth-client-secret` or `GEMINI_OAUTH_CLIENT_SECRET`
4. optional token cache path from `--oauth-token-file` or `GEMINI_OAUTH_TOKEN_FILE`

If neither auth path is configured, the script exits with an error message.

## Filename Generation

Generate filenames with the pattern: `yyyy-mm-dd-hh-mm-ss-name.png`

Format: `{timestamp}-{descriptive-name}.png`

- Timestamp: Current date/time in format `yyyy-mm-dd-hh-mm-ss` (24-hour format)
- Name: Descriptive lowercase text with hyphens
- Keep the descriptive part concise (1-5 words typically)
- Use context from user's prompt or conversation
- If unclear, use random identifier (e.g., `x9k2`, `a7b3`)

Examples:

- Prompt "A serene Japanese garden" → `2025-11-23-14-23-05-japanese-garden.png`
- Prompt "sunset over mountains" → `2025-11-23-15-30-12-sunset-mountains.png`
- Prompt "create an image of a robot" → `2025-11-23-16-45-33-robot.png`
- Unclear context → `2025-11-23-17-12-48-x9k2.png`

## Image Editing

When the user wants to modify an existing image:

1. Check if they provide an image path or reference an image in the current directory
2. Use `--input-image` parameter with the path to the image
3. The prompt should contain editing instructions (e.g., "make the sky more dramatic", "remove the person", "change to cartoon style")
4. Common editing tasks: add/remove elements, change style, adjust colors, blur background, etc.

## Prompt Handling

For generation: Pass user's image description as-is to `--prompt`. Only rework if clearly insufficient.

For editing: Pass editing instructions in `--prompt` (e.g., "add a rainbow in the sky", "make it look like a watercolor painting")

Preserve user's creative intent in both cases.

## Prompt Templates (high hit-rate)

Use templates when the user is vague or when edits must be precise.

- Generation template:
  - “Create an image of: <subject>. Style: <style>. Composition: <camera/shot>. Lighting: <lighting>. Background: <background>. Color palette: <palette>. Avoid: <list>.”

- Editing template (preserve everything else):
  - “Change ONLY: <single change>. Keep identical: subject, composition/crop, pose, lighting, color palette, background, text, and overall style. Do not add new objects. If text exists, keep it unchanged.”

## Output

- Saves PNG to current directory (or specified path if filename includes directory)
- Script outputs the full path to the generated image
- Do not read the image back - just inform the user of the saved path

## Examples

Generate new image:

    uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --prompt "A serene Japanese garden with cherry blossoms" --filename "2025-11-23-14-23-05-japanese-garden.png" --resolution 4K

Generate new image with OAuth:

    uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --auth-mode oauth --project "your-project-id" --oauth-client-secret "/path/to/client_secret.json" --prompt "A serene Japanese garden with cherry blossoms" --filename "2025-11-23-14-23-05-japanese-garden.png" --resolution 4K

Edit existing image:

    uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --prompt "make the sky more dramatic with storm clouds" --filename "2025-11-23-14-25-30-dramatic-sky.png" --input-image "original-photo.jpg" --resolution 2K
