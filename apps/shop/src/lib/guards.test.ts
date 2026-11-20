import { describe, expect, it } from 'vitest';
import { isPublicPath, redirectFor } from './guards';

describe('route guard', () => {
  it('waits while the session loads', () => {
    expect(redirectFor('/', 'loading', false)).toBeNull();
  });

  it('sends anonymous visitors to the sign-in, except on the public pages', () => {
    expect(redirectFor('/', 'anonymous', false)).toBe('/login');
    expect(redirectFor('/printer', 'anonymous', false)).toBe('/login');
    expect(redirectFor('/password', 'anonymous', false)).toBe('/login');
    expect(redirectFor('/login', 'anonymous', false)).toBeNull();
    expect(redirectFor('/register-device', 'anonymous', false)).toBeNull();
  });

  it('forces a required password change from every other page', () => {
    expect(redirectFor('/', 'ready', true)).toBe('/password');
    expect(redirectFor('/printer', 'ready', true)).toBe('/password');
    expect(redirectFor('/login', 'ready', true)).toBe('/password');
    expect(redirectFor('/password', 'ready', true)).toBeNull();
  });

  it('leads a signed-in cashier past the public pages and lets the rest open', () => {
    expect(redirectFor('/login', 'ready', false)).toBe('/');
    expect(redirectFor('/register-device', 'ready', false)).toBe('/');
    expect(redirectFor('/', 'ready', false)).toBeNull();
    expect(redirectFor('/printer', 'ready', false)).toBeNull();
    expect(redirectFor('/password', 'ready', false)).toBeNull();
  });

  it('knows the public paths', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
  });

  it('keeps agent owners on /owner and /password, and cashiers off /owner', () => {
    expect(redirectFor('/', 'ready', false, 'agent_owner')).toBe('/owner');
    expect(redirectFor('/printer', 'ready', false, 'agent_owner')).toBe('/owner');
    expect(redirectFor('/login', 'ready', false, 'agent_owner')).toBe('/owner');
    expect(redirectFor('/owner', 'ready', false, 'agent_owner')).toBeNull();
    expect(redirectFor('/password', 'ready', false, 'agent_owner')).toBeNull();
    expect(redirectFor('/owner', 'ready', true, 'agent_owner')).toBe('/password');
    expect(redirectFor('/owner', 'ready', false, 'cashier')).toBe('/');
  });
});
