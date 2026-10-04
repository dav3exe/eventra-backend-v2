/**
 * One-time seed script for the platform's admin account(s). There is no
 * admin self-registration route on purpose — registerSchema only accepts
 * role 'attendee' | 'organizer' (see schemaValidation.ts / auth.controller.ts's
 * register()), so this script is the ONLY way an admin user gets created.
 * Login itself needs no separate admin endpoint — /api/v1/auth/login already
 * works for any role and just sets req.session.role = user.role, so a
 * seeded admin logs in through the exact same login form/endpoint everyone
 * else uses. requireAdmin (auth.middleware.ts) is what actually gates every
 * /api/v1/admin/* route behind role === 'admin'.
 *
 * Run with: npm run seed:admin -- <email> <password> [fullname] [phone]
 * or set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_FULLNAME /
 * SEED_ADMIN_PHONE env vars instead. Safe to re-run: an existing admin with
 * that email is left untouched (password is not reset by re-running this).
 * Deliberately does NOT flip an existing attendee/organizer account to
 * admin — refuses instead, so an admin account is never created by accident
 * on top of a real user's data.
 */
import mongoose from 'mongoose'
import { env } from '../src/config/keys.js'
import User from '../src/models/user.model.js'
import dns from 'dns'

if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()))
}

const email = (process.argv[2] || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase()
const password = process.argv[3] || process.env.SEED_ADMIN_PASSWORD
const fullname = process.argv[4] || process.env.SEED_ADMIN_FULLNAME || 'Admin'
// The User schema requires `phone` for any non-organizer, non-Google account
// (see models/user.ts) — admin accounts fall into that same "requires phone"
// bucket today, so a placeholder is accepted here rather than failing the
// seed outright. Pass a real one via the 4th arg / SEED_ADMIN_PHONE if it matters.
const phone = process.argv[5] || process.env.SEED_ADMIN_PHONE || '0000000000'

if (!email || !password) {
  console.error('Usage: npm run seed:admin -- <email> <password> [fullname] [phone]')
  console.error('   (or set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD env vars)')
  process.exit(1)
}

const seed = async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DATABASE_NAME })
  console.log('Connected — seeding admin...')

  const existing = await User.findOne({ email })
  if (existing) {
    if (existing.role === 'admin') {
      console.log(`Already exists as admin: ${email} — nothing to do.`)
    } else {
      console.error(
        `A user with email ${email} already exists with role "${existing.role}" — refusing to overwrite it to admin. Use a different email or promote manually if that's really intended.`
      )
      process.exitCode = 1
    }
    await mongoose.disconnect()
    process.exit(existing.role === 'admin' ? 0 : 1)
  }

  // Password hashing happens in the User model's pre('save') hook — same
  // as every other account, nothing admin-specific there.
  await User.create({
    fullname,
    email,
    password,
    phone,
    role: 'admin',
    isVerified: true,
  })

  console.log(`Admin created: ${email}`)
  await mongoose.disconnect()
  process.exit(0)
}

seed().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
