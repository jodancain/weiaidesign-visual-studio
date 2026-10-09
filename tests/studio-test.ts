import { test as base, expect } from '@playwright/test';
/** Setup and browser actions must be the same anonymous visitor. The default
 * Playwright `request` fixture has its own cookie jar, unlike context.request. */
export const test = base.extend<{ studioOwner: void }>({
  studioOwner: [async ({ context, request }, use) => {
    const response = await request.get('/api/v3/session');
    expect(response.ok(), 'anonymous studio session is configured').toBeTruthy();
    const cookies = (await request.storageState()).cookies.filter(cookie => cookie.name === 'studio_v3_visitor');
    expect(cookies.length).toBe(1);
    await context.addCookies(cookies);
    await use();
  }, { auto: true }],
});
export { expect };
export type { Page, APIRequestContext } from '@playwright/test';
