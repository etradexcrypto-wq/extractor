# MailSift Email Extractor

A PIN-protected web app that extracts email addresses from pasted text, public websites, documents, and images. It does not call email-verification APIs and needs no paid API key.

## Supported sources

- Pasted text and publicly accessible HTTP/HTTPS pages (same-origin contact/about links are followed within a small page limit).
- PDF (text-based PDFs), DOCX, OpenDocument files (`.odt`, `.ods`, `.odp`, `.odf`) and flat ODF (`.fodt`, `.fods`, `.fodp`).
- TXT, CSV, TSV, HTML, Markdown, JSON, XML.
- PNG, JPEG, GIF, BMP, WebP, and TIFF images using Tesseract OCR. The first OCR request downloads English language data; outbound internet access is required, but no account or API key.

Only syntactically well-formed addresses at exactly `gmail.com`, `yahoo.com`, `aol.com`, `hotmail.com`, and `icloud.com` are returned. This does **not** confirm that a mailbox exists or can receive mail. Scanned/image-only PDFs are not OCRed as PDF pages; save those pages as images before uploading.

## Run locally

Requires Node.js `>=22.3.0 <23`.

```sh
cp .env.example .env
# Change EXTRACTION_PIN if desired. Replace AUTH_SECRET with a unique random value.
npm install
npm start
```

Open `http://localhost:3000`. The PIN is checked on the server, followed by an HttpOnly, SameSite=Strict session cookie with an eight-hour lifetime. Extraction requests are rejected while the session is locked.

## Deploy on cPanel

This app needs a cPanel host that provides **Setup Node.js App / Node.js Selector (Passenger) with Node.js 22.x**. The hosting provider must enable Node.js for your account. If cPanel has only PHP hosting and no Node.js app feature, this Express app cannot run on that plan; ask the host to enable Node.js or use a Node-capable plan.

For the classic **Setup Node.js App / Node.js Selector** flow:

1. Create a Node.js application in cPanel and select Node.js `22.x` (at least `22.3.0`). Set the application root to the project folder that contains `package.json`, `server.js`, and `app.js`. Attach the desired domain or subdomain and application URL. Keep the app root outside `public/`.
2. Upload the project files into that root. Do not upload `.env`, `.git`, or `node_modules`. The included `app.js` is the conventional startup entry point used by cPanel Passenger; keep it in the application root. If your cPanel interface has a startup-file field, set it to `app.js`.
3. Add these runtime environment variables in cPanel: `NODE_ENV=production`, `EXTRACTION_PIN` set to your chosen PIN, and `AUTH_SECRET` set to a unique random value. Generate a secret locally with `openssl rand -base64 48`. Do not use the example placeholder or publish the secret. The development PIN defaults to `79583`; change it before exposing the app publicly.
4. Install dependencies using cPanel's **Run NPM Install** control if available. Otherwise, activate the Node environment using the exact command shown on your cPanel app page, change to the app root, and run `npm install --omit=dev`.
5. Save/create the app and restart it from cPanel after changing code or environment variables. This Express app serves both the frontend from `public/` and all `/api/*` routes from the same process. Do not set `public/` as the application root or configure a separate rewrite for `/api/`.
6. Visit `https://your-domain/`. Check `https://your-domain/api/health`; a running app returns `{"ok":true,"service":"email-extractor"}`. Then unlock with your configured PIN and try a small text sample before uploading larger files.

Some newer cPanel accounts use the **Websites / Web Apps** interface instead. Its availability, supported Node versions, and settings depend on the hosting provider. If you use that flow, deploy the project ZIP or repository, select Node.js 22.x, set the same environment variables, and confirm the app is launched as a Node server using `app.js` (or the package's `npm start` command). If the UI does not offer a Node server/startup option, ask the host which Node.js application feature is enabled for your account.

The server listens on the `PORT` supplied by the hosting environment, with `3000` as a local-development fallback. If the app does not start, check the cPanel Node.js/Passenger application log and confirm the selected Node version, application root, startup entry, installed dependencies, and environment variables. For upload failures, check the host's request-body limit as well as the app's own limits.

Never commit `.env` or real credentials. `AUTH_SECRET` is separate from the PIN and signs the session cookie; changing either invalidates existing sessions after the app restarts.

## Runtime and security limits

Uploads are held in memory and are not saved. Use at most 10 files, keep each file at or below 4 MB, and keep the combined upload at or below 4 MB. The hosting provider may impose a lower request-body limit. OCR is CPU- and memory-intensive; very large images or many images in one request may exceed a shared hosting account's resource limits. Website scans are bounded, skip non-HTML/text pages, and block local/private-network targets. Sites requiring JavaScript rendering are not rendered in a headless browser and may not expose email addresses to this scanner.

The in-memory rate limiter is best-effort and resets when the Node process restarts; it is not a shared distributed limiter. A five-digit PIN is convenient access control, not strong identity authentication. Use a private deployment or stronger authentication before exposing sensitive workflows broadly.

## Checks

```sh
npm test
```
