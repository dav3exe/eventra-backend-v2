# Eventra Backend

REST API for **Eventra**, an event management and ticketing platform. It powers the [Eventra client](https://github.com/Chloetrini/Eventra-Client): attendees (including guests without an account) buy tickets, organizers run events and receive payouts, and admins moderate the platform.

## Tech stack

- **Node.js**, **TypeScript** (ESM, `NodeNext`), **Express 5**
- **MongoDB** with **Mongoose 9**, sessions stored with `connect-mongo`
- **Zod** for request validation, **pino** for logging, **helmet**, **cors** and **express-rate-limit** for hardening
- **Paystack** (payments, transfers, webhooks), **Cloudinary** (uploads), **Brevo** (transactional email), **Memcachier** (optional cache)
- **Vitest** for tests, deployed on **Vercel** (serverless functions and cron)

## Getting started

Requirements: Node 20+ and a MongoDB database.

```bash
npm install
cp .env.example .env    # then fill in the values
npm run dev             # http://localhost:4000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the API with nodemon and tsx |
| `npm test` / `npm run test:watch` | Run the Vitest suite |
| `npm run seed:categories` | Seed event categories |
| `npm run seed:admin` | Create the first admin from the `SEED_ADMIN_*` variables |

Type-check with `npx tsc --noEmit`.

### Environment variables

See `.env.example` for the full list. The server refuses to start if a required core variable (Mongo, session, client and API URLs, Cloudinary, Paystack) is missing. The Brevo, cron and admin-notification variables are read at use time, so they are not checked at boot. If they are wrong or missing, email or cron calls fail at runtime.

## Project structure

```
api/                Vercel entry (re-exports the Express app)
scripts/            One-off scripts: seed-admin, seed-categories, seed-events
docs/               Project notes
src/
├── index.ts        Express app, middleware stack and route mounting
├── config/         keys (validated env), database, logger, session, promotion packages
├── routes/         One router per resource (<name>.routes.ts)
├── controllers/    Request handlers (<name>.controller.ts)
├── services/       Business logic and integrations
│   ├── email/      email.service, send-email (Brevo), email-templates
│   ├── currency/   exchange-rate, viewer-currency
│   └── ...         ticket, paystack, cloudinary, notification, cache, session, refund-policy, ...
├── models/         Mongoose models (<name>.model.ts)
├── middlewares/    auth, admin-permission, rate-limit, cache, schema validation, errors, maintenance, upload
├── validators/     Zod schemas (schema-validation.ts)
├── utils/          Pure helpers (helpers, response-handler, try-catch-wrapper, qrcode, event-status, cron-auth)
└── jobs/           Scheduled work (<name>.job.ts)
```

Tests sit next to the code they cover (`*.test.ts`).

## API overview

All routes are mounted in `src/index.ts`.

| Prefix | Purpose |
| --- | --- |
| `/api/v1/auth` | Register, verify, login, Google sign-in, password reset |
| `/api/v1/events`, `/categories` | Event CRUD and discovery, categories |
| `/api/v1/tickets` | Free RSVP, paid checkout, order status, guest ticket access, refunds, check-in |
| `/api/v1/payments` | Paystack webhook |
| `/api/v1/organizers`, `/users` | Organizer onboarding, dashboards, settings, profiles |
| `/api/v1/promotions` | Paid event promotion |
| `/api/v1/admin` | Approvals, moderation, refunds and disputes, payouts, revenue, reports, team |
| `/api/v1/uploads`, `/notifications`, `/newsletter`, `/enquiries`, `/public` | Uploads, in-app notifications, newsletter, contact form, public data |
| `/api/cron-*` | Scheduled jobs (see below) |

`POST /tickets/rsvp/:eventId` and `POST /tickets/checkout/:eventId` do not require a session, so guests can buy tickets by supplying `guestName` and `guestEmail`.

## Scheduled jobs

Cron endpoints check the `x-cron-secret` header against `CRON_SECRET`. The schedule lives in `vercel.json`.

| Endpoint | Job | Schedule (UTC) |
| --- | --- | --- |
| `/api/cron-payouts` | `payout.job` | daily 03:00 |
| `/api/cron-promotion-expiry` | `promotion-expiry.job` | daily 04:00 |
| `/api/cron-daily-sales-summary` | `daily-sales-summary.job` | daily 07:00 |
| `/api/cron-event-reminders` | `event-reminder.job` | daily 09:00 |
| `/api/cron-weekly-picks` | `weekly-picks.job` | Mondays 10:00 |
| `/api/cron-email` | `email.job` (retries queued and failed emails) | not scheduled in `vercel.json` |

## Conventions

- File names are kebab-case with a role suffix: `ticket-type.controller.ts`, `order.model.ts`, `payout.job.ts`.
- Imports are relative and end in `.js` (ESM `NodeNext`), even for `.ts` sources.
- Controllers stay thin and wrap handlers in `try-catch-wrapper`. Business rules belong in `services/`.
- Validate request bodies with a Zod schema from `validators/` through the schema middleware.
- Respond with the helpers in `utils/response-handler.ts` so error shapes stay consistent.

## Deployment

Deployed on Vercel. `vercel.json` builds `src/index.ts` with `@vercel/node`, routes all traffic to it and defines the cron schedule. Set the environment variables from `.env.example` in the Vercel project settings.
