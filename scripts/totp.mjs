#!/usr/bin/env node
// Prints a fresh TOTP secret for the DASH_TOTP_SECRET unit line. Run: npm run totp:new
// Enrolment lives here rather than in the UI on purpose: the secret belongs in the service unit,
// not in the manifest, which gets copied into twenty history snapshots and is designed to be
// restored from. A second factor in a restorable file is not a second factor.
import { newSecret, otpauth, totp } from '../lib/totp.js'

const secret = newSecret()
console.log(`secret        ${secret}`)
console.log(`otpauth URI   ${otpauth(secret)}`)
console.log(`\nscan the URI as a QR code, or type the secret into the authenticator app.`)
console.log(`then, in /etc/systemd/system/nginx-dashboard.service:\n`)
console.log(`    Environment=DASH_TOTP_SECRET=${secret}\n`)
console.log(`and: systemctl daemon-reload && systemctl restart nginx-dashboard`)
console.log(`\nthe code right now is ${totp(secret)} — if the app shows that, the scan worked.`)
console.log(`lost the phone? remove that line, daemon-reload, restart.`)
