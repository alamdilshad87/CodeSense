import { strict as assert } from 'assert';
import { test } from 'node:test';
import { analyzeFile, symbolsInRange } from '../analysis/fileAnalyzer';

test('collects imports, re-exports, require and dynamic import', () => {
  const src = `
    import React, { useState } from 'react';
    import * as utils from './utils';
    export { thing } from './thing';
    export * from './all';
    const cfg = require('./config');
    async function lazy() { return import('./lazy'); }
  `;
  const a = analyzeFile('App.tsx', src);
  const froms = a.imports.map(i => i.from);
  assert.deepEqual(froms, ['react', './utils', './thing', './all', './config', './lazy']);
  assert.deepEqual(a.imports[0].names, ['React', 'useState']);
  assert.equal(a.imports[0].isRelative, false);
  assert.ok(a.roles.includes('React component'));
});

test('detects Angular roles and class members', () => {
  const src = `
    import { Injectable } from '@angular/core';
    @Injectable({ providedIn: 'root' })
    export class UserService { private cache = new Map(); getAll() {} save() {} }
  `;
  const a = analyzeFile('user.service.ts', src);
  assert.deepEqual(a.roles, ['Angular service']);
  const svc = a.symbols[0];
  assert.equal(svc.exported, true);
  assert.deepEqual(svc.members, ['cache', 'getAll', 'save']);
});

test('classifies tests, barrels and type-only files', () => {
  assert.ok(analyzeFile('a.spec.ts', '').roles.includes('Test file'));
  assert.ok(analyzeFile('index.ts', `export * from './a';`).roles.includes('Barrel / entry point'));
  assert.ok(analyzeFile('types.ts', 'export interface A {}\nexport type B = string;').roles.includes('Type definitions'));
});

test('symbolsInRange reports declarations and calls inside the selection', () => {
  const src = 'function outside() {}\nfunction inside() { fetchData(); this.log.info("x"); }';
  const start = src.indexOf('function inside');
  const r = symbolsInRange('a.ts', src, start, src.length);
  assert.deepEqual(r.declared, ['inside']);
  assert.deepEqual(r.called.sort(), ['fetchData', 'this.log.info']);
});
