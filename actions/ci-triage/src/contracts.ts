/**
 * Public CI Triage contracts: the domain vocabulary (outcomes, pull-request
 * modes, and reason codes) and the action composition surface. This module
 * intentionally exports only types, constants, and pure helpers; no
 * workflow-run resolution or Agent Tasks behavior is implemented here.
 */
export * from './domain/index.js';
export * from './action/index.js';
