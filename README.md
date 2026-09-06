# Web Event Check-in

A mobile-first Next.js PWA companion to the Android **Events-Registration** app. It mirrors the staff check-in workflow so Android and iPhone/iPad staff use the same attendance backend and the same acceptance override behavior.

## Matching Android behavior

- Staff access-key gate with master key + remote rotating key support.
- Remote-key kill switch for non-master staff sessions.
- QR camera scanning with rear-camera preference and flashlight support when the browser exposes it.
- Manual Registration ID fallback.
- Same `POST` attendance payload: `{ "registrationId": "...", "sudo": false }`.
- HTTP `403` opens **Skip / Accept & check in** and retries the same ID with `sudo: true`.
- Session-only **Allow unapproved attendees** switch; it always starts OFF after a fresh page/app session.
- Duplicate / pending-sync / error states and a 3-second scan debounce.
- Local pending queue (max 100) with automatic retry when the connection returns.
- System / Light / Dark theme and haptic feedback when supported.
- Installable PWA experience for iPhone/iPad via Safari → Share → Add to Home Screen.

## Security model

The browser never receives `APP_ACCESS_KEY`, `REMOTE_CONFIG_URL`, or the upstream attendance API secret configuration. Access keys are verified in server routes and successful login creates an HttpOnly signed staff-session cookie. The browser calls `/api/attendance`; the server validates the staff session and forwards the same request to the attendance API. This also avoids browser CORS issues.

Do **not** expose secrets using `NEXT_PUBLIC_*` variables.

## Environment

Copy `.env.example` to `.env.local` for local development and set:

```env
ATTENDANCE_API_URL=https://mlsaegypt.org/api/attendance/mark
APP_ACCESS_KEY=...
REMOTE_CONFIG_URL=https://.../raw-staff-key.txt
SESSION_SECRET=use-a-long-random-secret
```

Optional public support links:

```env
NEXT_PUBLIC_SUPPORT_EMAIL=...
NEXT_PUBLIC_SUPPORT_WHATSAPP=...
```

## Run locally

```bash
npm install
npm run dev
```

Camera access requires HTTPS in production (localhost is allowed during development).

## Deploy

The project is ready for Vercel. Add the server-side environment variables in the Vercel project settings, deploy, then open the HTTPS URL on iPhone/iPad. For an app-like experience, use Safari → Share → **Add to Home Screen**.
