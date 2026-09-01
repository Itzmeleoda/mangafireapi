#!/usr/bin/env node
// Generates an API key for the MangaFire API.
//   npm run genkey
// Then set it in your environment (Vercel → Settings → Environment Variables):
//   API_KEYS=mf-sk-<generated>
// Multiple keys: comma-separate them (API_KEYS=key1,key2).
import { randomBytes } from 'node:crypto';

console.log(`mf-sk-${randomBytes(24).toString('hex')}`);
