// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Every module's outermost error handler, shard 2 of 4.
 *
 * Each analyser wraps its work so an internal failure comes back as a result
 * the client can read, rather than an exception escaping to the transport.
 * That wrapper is only reached by making the filesystem fail, which is not
 * contrived: a revoked permission, a disk error, or a directory that vanishes
 * between two calls all surface exactly this way.
 *
 * The sweep is split across four files so the worker is recycled between
 * them; importing all 820 modules at once cost over 3 GB. Everything the
 * shards share lives in helpers/sweep-fs.ts.
 */


// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('path', () => require('./helpers/sweep-fs').pathMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./helpers/sweep-fs').fsMock());

import { defineSweep } from './helpers/sweep-fs';

defineSweep(1, 4);
