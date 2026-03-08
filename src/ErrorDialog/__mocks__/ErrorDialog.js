/**
 * Automatic Vitest mock for ErrorDialog.
 * Used when a test file calls vi.mock('../../src/ErrorDialog/ErrorDialog.js')
 * without a factory function.
 */
import { vi } from 'vitest';

export const showErrorDialog = vi.fn();
export const getDataFromError = vi.fn((e) => ({ title: String(e), description: String(e) }));
export const initErrorDialog = vi.fn();
