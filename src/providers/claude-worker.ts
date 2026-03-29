#!/usr/bin/env bun
/**
 * Claude Provider Worker — Anthropic's Claude via the Claude Agent SDK.
 *
 * Uses the default Anthropic API (no env overrides needed — auth via Claude login).
 */

import { createWorker } from './base-worker'

createWorker({
  name: 'claude',
})
