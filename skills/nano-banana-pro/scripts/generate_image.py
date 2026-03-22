#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
# "google-genai>=1.0.0",
# "google-auth>=2.0.0",
# "google-auth-oauthlib>=1.2.0",
# "pillow>=10.0.0",
# ]
# ///
"""
Generate images using Google's Nano Banana Pro (Gemini 3 Pro Image) API.

Usage:
 uv run generate_image.py --prompt "your image description" --filename "output.png" [--resolution 1K|2K|4K] [--api-key KEY]
"""

import argparse
import os
import sys
from pathlib import Path

VERTEX_AI_OAUTH_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("GEMINI_API_KEY")


def get_auth_mode(explicit_mode: str, api_key: str | None) -> str:
    """Resolve auth mode from CLI flags and environment."""
    if explicit_mode != "auto":
        return explicit_mode
    if api_key:
        return "api-key"
    return "oauth"


def get_env_or_default(value: str | None, env_name: str, default: str | None = None) -> str | None:
    """Return CLI value first, then environment, then fallback default."""
    if value:
        return value
    return os.environ.get(env_name, default)


def load_oauth_credentials(client_secret_path: Path, token_path: Path):
    """Load cached OAuth credentials or run the desktop login flow."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(
            str(token_path), VERTEX_AI_OAUTH_SCOPES
        )

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())

    if creds and creds.valid:
        return creds

    flow = InstalledAppFlow.from_client_secrets_file(
        str(client_secret_path), VERTEX_AI_OAUTH_SCOPES
    )
    creds = flow.run_local_server(port=0)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def create_client(args, api_key: str | None):
    """Create either a Gemini Developer API client or a Vertex AI client."""
    from google import genai

    auth_mode = get_auth_mode(args.auth_mode, api_key)
    if auth_mode == "api-key":
        if not api_key:
            print("Error: No API key provided for API key mode.", file=sys.stderr)
            sys.exit(1)
        return genai.Client(api_key=api_key), auth_mode

    project = get_env_or_default(args.project, "GOOGLE_CLOUD_PROJECT")
    if not project:
        print("Error: OAuth mode requires a Google Cloud project.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print(" 1. Provide --project", file=sys.stderr)
        print(" 2. Set GOOGLE_CLOUD_PROJECT", file=sys.stderr)
        sys.exit(1)

    location = get_env_or_default(args.location, "GOOGLE_CLOUD_LOCATION", "global")
    client_secret = get_env_or_default(
        args.oauth_client_secret, "GEMINI_OAUTH_CLIENT_SECRET"
    )
    token_file = Path(
        get_env_or_default(
            args.oauth_token_file,
            "GEMINI_OAUTH_TOKEN_FILE",
            str(Path.home() / ".config" / "nano-banana-pro" / "token.json"),
        )
    ).expanduser()

    if client_secret:
        client_secret_path = Path(client_secret).expanduser()
        if not client_secret_path.exists():
            print(
                f"Error: OAuth client secret file not found: {client_secret_path}",
                file=sys.stderr,
            )
            sys.exit(1)
        credentials = load_oauth_credentials(client_secret_path, token_file)
        return (
            genai.Client(
                vertexai=True,
                credentials=credentials,
                project=project,
                location=location,
            ),
            auth_mode,
        )

    # Fall back to application default credentials if no desktop OAuth secret is configured.
    return (
        genai.Client(vertexai=True, project=project, location=location),
        auth_mode,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Generate images using Nano Banana Pro (Gemini 3 Pro Image)"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Image description/prompt"
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., sunset-mountains.png)"
    )
    parser.add_argument(
        "--input-image", "-i",
        help="Optional input image path for editing/modification"
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["1K", "2K", "4K"],
        default="1K",
        help="Output resolution: 1K (default), 2K, or 4K"
    )
    parser.add_argument(
        "--api-key", "-k",
        help="Gemini API key (overrides GEMINI_API_KEY env var)"
    )
    parser.add_argument(
        "--auth-mode",
        choices=["auto", "api-key", "oauth"],
        default="auto",
        help="Authentication mode: api-key for Gemini API, oauth for Vertex AI, auto prefers API key",
    )
    parser.add_argument(
        "--project",
        help="Google Cloud project ID for OAuth/Vertex AI mode (overrides GOOGLE_CLOUD_PROJECT)",
    )
    parser.add_argument(
        "--location",
        help="Google Cloud location for OAuth/Vertex AI mode (overrides GOOGLE_CLOUD_LOCATION, defaults to global)",
    )
    parser.add_argument(
        "--oauth-client-secret",
        help="Desktop OAuth client JSON for Vertex AI mode (overrides GEMINI_OAUTH_CLIENT_SECRET)",
    )
    parser.add_argument(
        "--oauth-token-file",
        help="Path to cached OAuth token JSON (overrides GEMINI_OAUTH_TOKEN_FILE)",
    )
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)

    auth_mode = get_auth_mode(args.auth_mode, api_key)
    if auth_mode == "api-key" and not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print(" 1. Provide --api-key argument", file=sys.stderr)
        print(" 2. Set GEMINI_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)
    if auth_mode == "oauth" and not (
        args.project or os.environ.get("GOOGLE_CLOUD_PROJECT")
    ):
        print("Error: OAuth mode needs a Google Cloud project.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print(" 1. Provide --project argument", file=sys.stderr)
        print(" 2. Set GOOGLE_CLOUD_PROJECT environment variable", file=sys.stderr)
        sys.exit(1)

    # Import here after auth validation to keep help and config errors fast.
    from google.genai import types
    from PIL import Image as PILImage

    # Initialise client after deciding the auth path.
    client, resolved_auth_mode = create_client(args, api_key)

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Load input image if provided
    input_image = None
    output_resolution = args.resolution
    if args.input_image:
        try:
            input_image = PILImage.open(args.input_image)
            print(f"Loaded input image: {args.input_image}")
            # Auto-detect resolution if not explicitly set by user
            if args.resolution == "1K":  # Default value
                # Map input image size to resolution
                width, height = input_image.size
                max_dim = max(width, height)
                if max_dim >= 3000:
                    output_resolution = "4K"
                elif max_dim >= 1500:
                    output_resolution = "2K"
                else:
                    output_resolution = "1K"
                print(f"Auto-detected resolution: {output_resolution} (from input {width}x{height})")
        except Exception as e:
            print(f"Error loading input image: {e}", file=sys.stderr)
            sys.exit(1)
    # Build contents (image first if editing, prompt only if generating)
    if input_image:
        contents = [input_image, args.prompt]
        print(
            f"Editing image with resolution {output_resolution} using {resolved_auth_mode} auth..."
        )
    else:
        contents = args.prompt
        print(
            f"Generating image with resolution {output_resolution} using {resolved_auth_mode} auth..."
        )
    try:
        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    image_size=output_resolution
                )
            )
        )
        # Process response and convert to PNG
        image_saved = False
        for part in response.parts:
            if part.text is not None:
                print(f"Model response: {part.text}")
            elif part.inline_data is not None:
                # Convert inline data to PIL Image and save as PNG
                from io import BytesIO

                # inline_data.data is already bytes, not base64
                image_data = part.inline_data.data
                if isinstance(image_data, str):
                    # If it's a string, it might be base64
                    import base64
                    image_data = base64.b64decode(image_data)

                image = PILImage.open(BytesIO(image_data))
                # Ensure RGB mode for PNG (convert RGBA to RGB with white background if needed)
                if image.mode == 'RGBA':
                    rgb_image = PILImage.new('RGB', image.size, (255, 255, 255))
                    rgb_image.paste(image, mask=image.split()[3])
                    rgb_image.save(str(output_path), 'PNG')
                elif image.mode == 'RGB':
                    image.save(str(output_path), 'PNG')
                else:
                    image.convert('RGB').save(str(output_path), 'PNG')
                image_saved = True
        if image_saved:
            full_path = output_path.resolve()
            print(f"\nImage saved: {full_path}")
        else:
            print("Error: No image was generated in the response.", file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
