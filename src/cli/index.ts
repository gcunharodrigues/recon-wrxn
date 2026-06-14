#!/usr/bin/env node

/**
 * recon-wrxn CLI
 *
 * Lightweight code intelligence for any Go + TypeScript codebase.
 * Usage: npx recon-wrxn <command>
 */

import { buildProgram } from './program.js';

buildProgram().parse();
