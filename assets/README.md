# Watermark logo

Place the Rabotka logo file here as `rabotka-logo.png` for image watermarking.

All images uploaded to the platform (profile avatars, KYC documents, etc.) will have this logo overlaid with configurable opacity before being stored. If this file is missing, uploads succeed without a watermark.

Override the path or opacity via environment variables:
- `WATERMARK_LOGO_PATH` – path to the logo (absolute or relative to project root)
- `WATERMARK_OPACITY` – 0 to 1 (default 0.3)
