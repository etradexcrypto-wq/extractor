# MailSift Email Extractor

A small, PIN-protected web app that extracts addresses from pasted text, public web pages, and uploaded documents/images. It makes no email-verification API calls and does not require a paid API key.

## Supported sources

- Pasted text and publicly accessible HTTP/HTTPS pages (same-origin contact/about links are followed within a small page limit).
- PDF (text-based PDFs), DOCX, OpenDocument files (`.odt`, `.ods`, `.odp`, `.odf`) and flat ODF (`.fodt`, `.fods`, `.fodp`).
- TXT, CSV, TSV, HTML, Markdown, JSON, XML.
- PNG, JPEG, GIF, BMP, WebP, and TIFF images using Tesseract OCR. The first OCR request downloads English language data; this needs outbound internet access but no account or API key.

Only syntactically well-formed addresses at exactly `gmail.com`, `yahoo.com`, `aol.com`, `hotmail.com`, and `icloud.com` are returned. This does **not** prove that a mailbox exists or can receive mail; that cannot be established reliably without sending a message or using a verification service. Scanned/image-only PDFs are not OCRed as PDF pages; save those pages as images before uploading.

## Run locally

Requires Node.js 22.3 or newer (Node 22.x is selected for Vercel).

```sh
cp .env.example .env
# Keep the development PIN 79583 or set your own EXTRACTION_PIN.
# Replace AUTH_SECRET with a random value; for local use it can be any long string.
npm install
npm start
```

Open `http://localhost:3000`. The PIN is checked on the server, followed by an HttpOnly, SameSite=Strict session cookie with an eight-hour lifetime. Extraction requests are rejected when the session is locked.

## Deploy to Vercel

1. Import the project folder/repository into Vercel and deploy with the Node.js runtime. The included `vercel.json` routes `/api/*` to the catch-all Node function; `public/` contains the static UI.
2. In **Project Settings → Environment Variables**, set:
   - `EXTRACTION_PIN` to your chosen PIN. The initial/default value is `79583`; change it before a public deployment if you want a private PIN. Change the Vercel variable and redeploy whenever you rotate it; existing sessions are invalidated automatically.
   - `AUTH_SECRET` to a unique random secret, e.g. generate one with `openssl rand -base64 48`. Do not reuse the example placeholder.
3. Redeploy after adding or changing environment variables.

Never commit `.env` or real credentials. `AUTH_SECRET` is separate from the PIN and signs the stateless session cookie across Vercel instances. If you rotate it, existing sessions are invalidated.

## Deployment/runtime limits

Uploads are held in memory and are not saved. Keep the combined upload at or below 4 MB, use at most 10 files, and keep each file below 4 MB. This is intentionally conservative for Vercel's serverless request body constraints. OCR is CPU- and memory-intensive; very large images or many images in one request may exceed serverless time limits. Website scans are bounded, skip non-HTML/text pages, and block local/private-network targets. Sites requiring JavaScript rendering are not rendered by a headless browser and may not expose their email addresses to this scanner.

The small in-memory rate limiter is best-effort on serverless infrastructure; it is not a substitute for a shared distributed rate limiter if the app becomes public or high-traffic. A five-digit PIN is convenient access control, not strong identity authentication. Use a private deployment or replace it with stronger authentication before exposing sensitive workflows broadly.

## Checks

```sh
npm test
```
