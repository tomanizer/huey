// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady } = require('./helpers/app-bootstrap');

test.describe('Theme', () => {
  test('toggle theme updates CSS variables', async ({ page }) => {
    await waitForAppReady(page);

    const initialBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--huey-medium-background-color').trim()
    );

    const settingsTrigger = page.locator('label[for="settingsButton"]');
    await expect(settingsTrigger).toBeVisible({ timeout: 30000 });
    await settingsTrigger.click({ timeout: 30000 });
    await page.locator('label[for="themeSettingsTab"]').click();

    const themeSelect = page.locator('#themes');
    await expect(themeSelect).toBeVisible({ timeout: 20000 });
    await expect(themeSelect).toBeEnabled({ timeout: 20000 });

    const options = themeSelect.locator('option');
    const optionCount = await options.count();
    const targetIndex = optionCount > 1 ? 1 : 0;
    const targetValue = await options.nth(targetIndex).getAttribute('value');
    if (targetValue) {
      await themeSelect.selectOption(targetValue);
    }

    const updatedBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--huey-medium-background-color').trim()
    );

    if (optionCount > 1) {
      await expect(updatedBg).not.toBe(initialBg);
    } else {
      await expect(updatedBg).toBeTruthy();
    }
    await page.click('#settingsDialogOkButton');
  });
});
